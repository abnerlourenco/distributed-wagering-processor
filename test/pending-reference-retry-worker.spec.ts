
import { describe, expect, it, vi } from 'vitest';
import { PendingReferenceRetryWorker } from '../src/infra/messaging/references/pending-reference-retry.worker.js';
import { MikroOrmPendingReferenceRetriesRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-pending-reference-retries.repository.js';
import { ProcessWagerTransactionUseCase } from '../src/domain/wagering/application/use-cases/process-wager-transaction.js';

describe('PendingReferenceRetryWorker shutdown', () => {
  it('waits for the active retry cycle before shutting down', async () => {
    let resolveProcessing!: () => void;

    const processing = new Promise<void>((resolve) => {
      resolveProcessing = resolve;
    });

    const repository = {
      claimDue: vi.fn().mockResolvedValue([]),
    };

    const processTransaction = {
      execute: vi.fn().mockReturnValue(processing),
    };

    const worker = new PendingReferenceRetryWorker(
      repository as unknown as MikroOrmPendingReferenceRetriesRepository,
      processTransaction as unknown as ProcessWagerTransactionUseCase,
    );

    const transaction = {
      id: 'transaction-1',
      createdAt: new Date(),
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      idempotencyKey: 'idempotency-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'WIN' as const,
      amount: '5.00',
      currency: 'BRL',
      referenceExternalTransactionId: 'reference-1',
    };

    repository.claimDue.mockResolvedValue([transaction]);

    worker.onApplicationBootstrap();

    // Aguarda o timer inicial do worker disparar.
    await vi.waitFor(() => {
      expect(repository.claimDue).toHaveBeenCalledOnce();
      expect(processTransaction.execute).toHaveBeenCalledOnce();
    });

    let shutdownCompleted = false;

    const shutdown = worker.onApplicationShutdown().then(() => {
      shutdownCompleted = true;
    });

    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);

    resolveProcessing();
    await shutdown;

    expect(shutdownCompleted).toBe(true);
  });

  it('does not start another cycle after shutdown', async () => {
    vi.useFakeTimers();

    try {
      const repository = {
        claimDue: vi.fn().mockResolvedValue([]),
      };

      const processTransaction = {
        execute: vi.fn(),
      };

      const worker = new PendingReferenceRetryWorker(
        repository as unknown as MikroOrmPendingReferenceRetriesRepository,
        processTransaction as unknown as ProcessWagerTransactionUseCase,
      );

      worker.onApplicationBootstrap();

      await vi.advanceTimersByTimeAsync(0);

      expect(repository.claimDue).toHaveBeenCalledOnce();

      await worker.onApplicationShutdown();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(repository.claimDue).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
