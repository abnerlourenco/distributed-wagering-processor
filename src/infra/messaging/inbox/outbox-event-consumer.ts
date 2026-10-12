import { Logger } from '@nestjs/common';
import { SqsMessageAdapter } from '../sqs/sqs-message-adapter.js';
import { MikroOrmInboxConsumerRepository } from './mikro-orm-inbox-consumer.repository.js';
import { outboxEventSchema } from './outbox-event.schema.js';

export class InvalidOutboxEventError extends Error {
  constructor(reason: 'INVALID_JSON' | 'INVALID_SCHEMA') {
    super(`Outbox event rejected: ${reason}`);
    this.name = 'InvalidOutboxEventError';
  }
}

export class OutboxEventConsumer {
  private readonly logger = new Logger(OutboxEventConsumer.name);
  private queueUrl: string | undefined;
  private readonly abortController = new AbortController();

  constructor(
    private readonly repository: MikroOrmInboxConsumerRepository,
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

    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(message.body);
    } catch {
      this.logger.warn(
        `Invalid JSON in SQS message ${message.messageId}; receive count=${message.receiveCount}`,
      );
      throw new InvalidOutboxEventError('INVALID_JSON');
    }

    const validation = outboxEventSchema.safeParse(parsedBody);

    if (!validation.success) {
      this.logger.warn(
        `Invalid Outbox event schema in SQS message ${message.messageId}; receive count=${message.receiveCount}`,
      );
      throw new InvalidOutboxEventError('INVALID_SCHEMA');
    }

    const event = validation.data;

    const result = await this.repository.recordReceived(
      'wagering-outbox-event-consumer',
      this.queueName,
      {
        messageId: event.messageId,
        messageType: event.eventType,
        payload: event,
      },
    );

    await this.sqs.deleteMessage(this.queueUrl, message.receiptHandle);

    if (result.duplicate) {
      this.logger.debug(
        `Ignored duplicate Outbox event ${event.messageId}`,
      );
    }

    return true;
  }

  stop(): void {
    this.abortController.abort();
  }
}