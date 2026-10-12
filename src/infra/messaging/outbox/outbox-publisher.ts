import { Logger } from '@nestjs/common';
import { MikroOrmOutboxPublisherRepository } from './mikro-orm-outbox-publisher.repository.js';
import { SqsMessageAdapter } from '../sqs/sqs-message-adapter.js';
import { MetricsRegistry } from '../../observability/metrics-registry.js';
import { runWithObservationContext } from '../../observability/observation-context.js';

const OUTBOX_BATCH_SIZE = 10;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_OUTBOX_ATTEMPTS = 5;

export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly queueUrls = new Map<string, string>();

  constructor(
    private readonly repository: MikroOrmOutboxPublisherRepository,
    private readonly sqs: SqsMessageAdapter,
    private readonly queueName: string,
    private readonly commandQueueName?: string,
    private readonly maxAttempts = MAX_OUTBOX_ATTEMPTS,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async publishAvailable(): Promise<{ published: number; failed: number }> {
    const messages = await this.repository.claimAvailable(OUTBOX_BATCH_SIZE);
    let published = 0;
    let failed = 0;

    for (const message of messages) {
      let sendAttempted = false;
      try {
        const isCommand = message.eventType === 'WagerTransactionRequested';
        const targetQueue = isCommand ? this.commandQueueName : this.queueName;
        if (!targetQueue) {
          throw new Error('Wager command queue is not configured');
        }
        let queueUrl = this.queueUrls.get(targetQueue);
        if (!queueUrl) {
          queueUrl = await this.sqs.getQueueUrl(targetQueue);
          this.queueUrls.set(targetQueue, queueUrl);
        }

        const payload = message.payload;
        const walletId =
          typeof payload.walletId === 'string' ? payload.walletId : undefined;
        if (isCommand && !walletId) {
          throw new Error('Wager command is missing its wallet group ID');
        }
        sendAttempted = true;
        const { amount, currency, correlationId, ...commandData } =
          message.payload;
        const envelope = isCommand
          ? {
              messageId: message.id,
              type: message.eventType,
              ...(typeof correlationId === 'string' ? { correlationId } : {}),
              occurredAt: new Date(message.occurredAt).toISOString(),
              data: {
                ...commandData,
                money: { amount, currency },
              },
            }
          : {
              messageId: message.id,
              aggregateType: message.aggregateType,
              aggregateId: message.aggregateId,
              eventType: message.eventType,
              occurredAt: new Date(message.occurredAt).toISOString(),
              payload: message.payload,
            };
        await this.sqs.sendMessage(
          queueUrl,
          JSON.stringify(envelope),
          isCommand
            ? {
                messageGroupId: walletId,
                messageDeduplicationId: message.id,
              }
            : undefined,
        );
      } catch (error) {
        const errorCode = this.getErrorCode(error);
        const hasUncertainDelivery =
          sendAttempted ||
          message.lastErrorCode?.startsWith('SQS_SEND_OUTCOME_UNKNOWN:') ===
            true;
        if (message.attempts >= this.maxAttempts) {
          const markedDead = await this.repository.markDead(
            message,
            `MAX_PUBLISH_ATTEMPTS_${hasUncertainDelivery ? 'OUTCOME_UNKNOWN' : 'NOT_SENT'}:${errorCode}`.slice(
              0,
              128,
            ),
            !hasUncertainDelivery,
          );
          if (markedDead) {
            failed += 1;
            this.logForMessage(
              message,
              'error',
              `Outbox message ${message.id} moved to DEAD after ${message.attempts} attempts (${errorCode})`,
            );
          } else {
            this.logForMessage(
              message,
              'warn',
              `Outbox message ${message.id} could not be marked DEAD because its claim is no longer current`,
            );
          }
          continue;
        }

        const retryDelayMs = Math.min(
          MAX_RETRY_DELAY_MS,
          1000 * 2 ** Math.min(message.attempts - 1, 9),
        );
        const markedFailed = await this.repository.markFailed(
          message,
          retryDelayMs,
          `${sendAttempted ? 'SQS_SEND_OUTCOME_UNKNOWN:' : ''}${errorCode}`.slice(
            0,
            128,
          ),
        );

        if (markedFailed) {
          failed += 1;
          this.metrics?.retries.labels('outbox_publish').inc();
          this.logForMessage(
            message,
            'warn',
            `Outbox message ${message.id} publication failed (${errorCode}); retry scheduled`,
          );
        } else {
          this.logForMessage(
            message,
            'warn',
            `Outbox message ${message.id} could not be marked failed because its claim is no longer current`,
          );
        }
        continue;
      }

      const markedPublished = await this.repository.markPublished(message);
      if (markedPublished) {
        published += 1;
      } else {
        this.logForMessage(
          message,
          'warn',
          `Outbox message ${message.id} was sent but its claim is no longer current; it may be delivered again`,
        );
      }
    }

    return { published, failed };
  }

  private getErrorCode(error: unknown): string {
    if (!(error instanceof Error)) {
      return 'UnknownPublishError';
    }

    const safeName = error.name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
    return safeName || 'PublishError';
  }

  private logForMessage(
    message: {
      id: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
    level: 'error' | 'warn',
    logMessage: string,
  ): void {
    const context = {
      correlationId:
        typeof message.payload.correlationId === 'string'
          ? message.payload.correlationId
          : message.id,
      messageId: message.id,
      transactionId:
        typeof message.payload.transactionId === 'string'
          ? message.payload.transactionId
          : undefined,
      walletId:
        typeof message.payload.walletId === 'string'
          ? message.payload.walletId
          : message.aggregateId,
      providerId:
        typeof message.payload.providerId === 'string'
          ? message.payload.providerId
          : undefined,
    };

    runWithObservationContext(context, () => {
      this.logger[level](logMessage);
    });
  }
}
