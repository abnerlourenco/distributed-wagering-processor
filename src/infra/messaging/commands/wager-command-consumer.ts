import { Logger } from '@nestjs/common';
import { Money } from '../../../core/domain/money.js';
import { ProcessWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/process-wager-transaction.js';
import { SqsMessageAdapter } from '../sqs/sqs-message-adapter.js';
import { wagerCommandSchema } from './wager-command.schema.js';

export class WagerCommandConsumer {
  private readonly logger = new Logger(WagerCommandConsumer.name);
  private queueUrl: string | undefined;
  private readonly abortController = new AbortController();

  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly sqs: SqsMessageAdapter,
    private readonly queueName: string,
    private readonly waitTimeSeconds = 10,
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

    const command = wagerCommandSchema.parse(JSON.parse(message.body));
    await this.processTransaction.execute({
      transactionId: command.payload.transactionId,
      createdAt: new Date(command.payload.createdAt),
      providerId: command.payload.providerId,
      externalTransactionId: command.payload.externalTransactionId,
      idempotencyKey: command.payload.idempotencyKey,
      walletId: command.payload.walletId,
      playerId: command.payload.playerId,
      roundId: command.payload.roundId,
      gameId: command.payload.gameId,
      kind: command.payload.kind,
      money: Money.from({
        amount: command.payload.amount,
        currency: command.payload.currency,
      }),
      ...(command.payload.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              command.payload.referenceExternalTransactionId,
          }
        : {}),
    });

    await this.sqs.deleteMessage(this.queueUrl, message.receiptHandle);
    this.logger.debug(`Processed wager command ${command.messageId}`);
    return true;
  }

  stop(): void {
    this.abortController.abort();
  }
}
