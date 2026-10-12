import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InvalidOutboxEventError, OutboxEventConsumer } from './outbox-event-consumer.js';

const EMPTY_QUEUE_DELAY_MS = 1000;
const ERROR_DELAY_MS = 5000;

@Injectable()
export class OutboxEventConsumerWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxEventConsumerWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly consumer: OutboxEventConsumer) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.consumer.stop();

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;

      const cycle = this.consumeCycle();
      this.inFlight = cycle;

      void cycle.finally(() => {
        if (this.inFlight === cycle) {
          this.inFlight = undefined;
        }
      });
    }, delayMs);
  }

  private async consumeCycle(): Promise<void> {
    let nextDelay = 0;

    try {
      const consumed = await this.consumer.consumeOne();
      nextDelay = consumed ? 0 : EMPTY_QUEUE_DELAY_MS;
    } catch (error) {
      if (!this.stopped) {
        if (error instanceof InvalidOutboxEventError) {
          this.logger.warn(
            `Invalid Outbox message; SQS redrive policy must handle repeated receives (${error.message})`,
          );
        } else {
          const errorName =
            error instanceof Error ? error.name : 'UnknownConsumerError';

          this.logger.error(
            `Outbox event consumption failed (${errorName})`,
          );
        }

        nextDelay = ERROR_DELAY_MS;
      }
    } finally {
      this.schedule(nextDelay);
    }
  }
}