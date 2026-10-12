import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { OutboxEventConsumer } from './outbox-event-consumer.js';

const EMPTY_QUEUE_DELAY_MS = 1000;
const ERROR_DELAY_MS = 5000;

@Injectable()
export class OutboxEventConsumerWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxEventConsumerWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly consumer: OutboxEventConsumer) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.consumeCycle();
    }, delayMs);
  }

  private async consumeCycle(): Promise<void> {
    let nextDelay = 0;
    try {
      const consumed = await this.consumer.consumeOne();
      nextDelay = consumed ? 0 : EMPTY_QUEUE_DELAY_MS;
    } catch (error) {
      const errorName =
        error instanceof Error ? error.name : 'UnknownConsumerError';
      this.logger.error(`Outbox event consumption failed (${errorName})`);
      nextDelay = ERROR_DELAY_MS;
    } finally {
      this.schedule(nextDelay);
    }
  }
}
