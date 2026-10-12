import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { WagerCommandConsumer } from './wager-command-consumer.js';

const EMPTY_QUEUE_DELAY_MS = 1000;
const ERROR_DELAY_MS = 5000;

@Injectable()
export class WagerCommandConsumerWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WagerCommandConsumerWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly consumer: WagerCommandConsumer) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.consumer.stop();
    if (this.timer) {
      clearTimeout(this.timer);
    }
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.consumeCycle();
    }, delayMs);
  }

  private async consumeCycle(): Promise<void> {
    let nextDelay = 0;
    try {
      const consumed = await this.consumer.consumeOne();
      nextDelay = consumed ? 0 : EMPTY_QUEUE_DELAY_MS;
    } catch (error) {
      if (!this.stopped) {
        const errorName =
          error instanceof Error ? error.name : 'UnknownConsumerError';
        this.logger.error(`Wager command consumption failed (${errorName})`);
        nextDelay = ERROR_DELAY_MS;
      }
    } finally {
      this.schedule(nextDelay);
    }
  }
}
