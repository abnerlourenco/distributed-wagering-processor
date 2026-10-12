import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { DomainError } from '../../../core/domain/domain-error.js';
import { Money } from '../../../core/domain/money.js';
import { ProcessWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/process-wager-transaction.js';
import {
  InboxPayloadConflictError,
  MikroOrmInboxConsumerRepository,
} from '../inbox/mikro-orm-inbox-consumer.repository.js';
import { SqsMessageAdapter } from '../sqs/sqs-message-adapter.js';
import { wagerCommandSchema } from './wager-command.schema.js';
import { MetricsRegistry } from '../../observability/metrics-registry.js';
import { runWithObservationContext } from '../../observability/observation-context.js';

const MAX_RETRY_DELAY_SECONDS = 300;
const COMMAND_CONSUMER_NAME = 'wager-transaction-command-consumer';
const COMMAND_INBOX_SOURCE = 'wager-transactions.fifo';

export class WagerCommandConsumer {
  private readonly logger = new Logger(WagerCommandConsumer.name);
  private queueUrl: string | undefined;
  private readonly abortController = new AbortController();

  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly inbox: MikroOrmInboxConsumerRepository,
    private readonly sqs: SqsMessageAdapter,
    private readonly queueName: string,
    private readonly waitTimeSeconds = 10,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async consumeOne(): Promise<boolean> {
    this.queueUrl ??= await this.sqs.getQueueUrl(this.queueName);
    const message = await this.sqs.receiveMessage(
      this.queueUrl,
      this.waitTimeSeconds,
      this.abortController.signal,
    );
    if (!message) {
      return false;
    }

    const queueUrl = this.queueUrl;
    let command: ReturnType<typeof wagerCommandSchema.parse>;
    try {
      command = wagerCommandSchema.parse(JSON.parse(message.body));
    } catch (error) {
      await runWithObservationContext(
        {
          correlationId: message.messageId,
          messageId: message.messageId,
        },
        () => this.deferOrDeadLetter(queueUrl, message, error),
      );
      return true;
    }

    const transactionId =
      command.data.transactionId ?? this.stableTransactionId(command.messageId);
    await runWithObservationContext(
      {
        correlationId: command.correlationId ?? command.messageId,
        messageId: command.messageId,
        transactionId,
        walletId: command.data.walletId,
        providerId: command.data.providerId,
      },
      async () => {
        const startedAt = performance.now();
        try {
          const inboxResult = await this.inbox.recordReceived(
            COMMAND_CONSUMER_NAME,
            COMMAND_INBOX_SOURCE,
            {
              messageId: command.messageId,
              messageType: command.type,
              payload: command.data,
            },
          );
          if (inboxResult.duplicate) {
            this.metrics?.duplicates.labels('sqs_inbox').inc();
          }

          await this.processTransaction.execute({
            transactionId,
            createdAt: new Date(command.data.createdAt ?? command.occurredAt),
            providerId: command.data.providerId,
            externalTransactionId: command.data.externalTransactionId,
            idempotencyKey: command.data.idempotencyKey,
            walletId: command.data.walletId,
            playerId: command.data.playerId,
            roundId: command.data.roundId,
            gameId: command.data.gameId,
            kind: command.data.kind,
            money: Money.from(command.data.money),
            ...(command.data.referenceExternalTransactionId
              ? {
                  referenceExternalTransactionId:
                    command.data.referenceExternalTransactionId,
                }
              : {}),
          });

          await this.sqs.deleteMessage(queueUrl, message.receiptHandle);
          this.logger.debug(
            `${inboxResult.duplicate ? 'Reprocessed duplicate' : 'Processed'} wager command`,
          );
        } catch (error) {
          if (error instanceof DomainError) {
            this.logger.warn(
              `Wager command reached a terminal business error (${error.name}); acknowledging`,
            );
            await this.sqs.deleteMessage(queueUrl, message.receiptHandle);
          } else {
            await this.deferOrDeadLetter(queueUrl, message, error);
          }
        } finally {
          this.metrics?.processingDurationSeconds.observe(
            (performance.now() - startedAt) / 1000,
          );
        }
      },
    );
    return true;
  }

  stop(): void {
    this.abortController.abort();
  }

  private async deferOrDeadLetter(
    queueUrl: string,
    message: { receiptHandle: string; receiveCount: number },
    error: unknown,
  ): Promise<void> {
    const permanent =
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      error instanceof InboxPayloadConflictError;
    const delaySeconds = permanent
      ? 0
      : Math.min(
          MAX_RETRY_DELAY_SECONDS,
          2 ** Math.min(message.receiveCount - 1, 8),
        );
    await this.sqs.changeMessageVisibility(
      queueUrl,
      message.receiptHandle,
      delaySeconds,
    );

    const category = permanent ? 'permanent' : 'transient';
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    this.metrics?.retries.labels('sqs_consumer').inc();
    this.logger.warn(
      `Wager command ${category} failure (${errorName}); retry ${message.receiveCount} scheduled`,
    );
  }

  private stableTransactionId(messageId: string): string {
    const bytes = createHash('sha256')
      .update(messageId)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
