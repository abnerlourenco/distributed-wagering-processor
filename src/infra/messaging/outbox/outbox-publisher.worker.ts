
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { OutboxPublisher } from './outbox-publisher.js';

const POLL_INTERVAL_MS = 1000;
const ERROR_DELAY_MS = 5000;

@Injectable()
export class OutboxPublisherWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly publisher: OutboxPublisher) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;

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

      const cycle = this.publishCycle();
      this.inFlight = cycle;

      void cycle.finally(() => {
        if (this.inFlight === cycle) {
          this.inFlight = undefined;
        }
      });
    }, delayMs);
  }

  private async publishCycle(): Promise<void> {
    let nextDelay = POLL_INTERVAL_MS;

    try {
      await this.publisher.publishAvailable();
    } catch (error) {
      const errorCode =
        error instanceof Error ? error.name : 'UnknownPublisherError';

      this.logger.error(`Outbox publisher cycle failed (${errorCode})`);
      nextDelay = ERROR_DELAY_MS;
    } finally {
      this.schedule(nextDelay);
    }
  }
}
