import { Logger } from '@nestjs/common';
import { MikroOrmOutboxPublisherRepository } from './mikro-orm-outbox-publisher.repository.js';
import { SqsMessageAdapter } from '../sqs/sqs-message-adapter.js';

const OUTBOX_BATCH_SIZE = 10;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly queueUrls = new Map<string, string>();

  constructor(
    private readonly repository: MikroOrmOutboxPublisherRepository,
    private readonly sqs: SqsMessageAdapter,
    private readonly queueName: string,
    private readonly commandQueueName?: string,
  ) {}

  async publishAvailable(): Promise<{ published: number; failed: number }> {
    const messages = await this.repository.claimAvailable(OUTBOX_BATCH_SIZE);
    let published = 0;
    let failed = 0;

    for (const message of messages) {
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
        await this.sqs.sendMessage(
          queueUrl,
          JSON.stringify({
            messageId: message.id,
            aggregateType: message.aggregateType,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            occurredAt: new Date(message.occurredAt).toISOString(),
            payload: message.payload,
          }),
          isCommand
            ? {
                messageGroupId: walletId,
                messageDeduplicationId: message.id,
              }
            : undefined,
        );
      } catch (error) {
        const errorCode = this.getErrorCode(error);
        const retryDelayMs = Math.min(
          MAX_RETRY_DELAY_MS,
          1000 * 2 ** Math.min(message.attempts - 1, 9),
        );
        const markedFailed = await this.repository.markFailed(
          message,
          retryDelayMs,
          errorCode,
        );

        if (markedFailed) {
          failed += 1;
          this.logger.warn(
            `Outbox message ${message.id} publication failed (${errorCode}); retry scheduled`,
          );
        } else {
          this.logger.warn(
            `Outbox message ${message.id} could not be marked failed because its claim is no longer current`,
          );
        }
        continue;
      }

      const markedPublished = await this.repository.markPublished(message);
      if (markedPublished) {
        published += 1;
      } else {
        this.logger.warn(
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
}
