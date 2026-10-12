import { describe, expect, it, vi } from 'vitest';
import { OutboxPublisherWorker } from '../src/infra/messaging/outbox/outbox-publisher.worker.js';
import { OutboxPublisher } from '../src/infra/messaging/outbox/outbox-publisher.js';

describe('OutboxPublisherWorker shutdown', () => {
  it('waits for an active publication before shutting down', async () => {
    let resolvePublication!: () => void;

    const publication = new Promise<void>((resolve) => {
      resolvePublication = resolve;
    });

    const publisher = {
      publishAvailable: vi.fn().mockReturnValue(publication),
    };

    const worker = new OutboxPublisherWorker(
      publisher as unknown as OutboxPublisher,
    );

    worker.onApplicationBootstrap();

    await vi.waitFor(() => {
      expect(publisher.publishAvailable).toHaveBeenCalledOnce();
    });

    let shutdownCompleted = false;

    const shutdown = worker.onApplicationShutdown().then(() => {
      shutdownCompleted = true;
    });

    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);

    resolvePublication();
    await shutdown;

    expect(shutdownCompleted).toBe(true);
  });

  it('does not publish again after shutdown', async () => {
    vi.useFakeTimers();

    try {
      const publisher = {
        publishAvailable: vi.fn().mockResolvedValue(undefined),
      };

      const worker = new OutboxPublisherWorker(
        publisher as unknown as OutboxPublisher,
      );

      worker.onApplicationBootstrap();

      await vi.advanceTimersByTimeAsync(0);
      expect(publisher.publishAvailable).toHaveBeenCalledOnce();

      await worker.onApplicationShutdown();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(publisher.publishAvailable).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
