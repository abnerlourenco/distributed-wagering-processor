import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { OutboxPublisher } from './outbox-publisher.js';

const POLL_INTERVAL_MS = 1000;

@Injectable()
export class OutboxPublisherWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly publisher: OutboxPublisher) {}

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
      void this.publishCycle();
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
      nextDelay = 5000;
    } finally {
      this.schedule(nextDelay);
    }
  }
}
