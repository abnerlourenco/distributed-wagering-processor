import { describe, expect, it } from 'vitest';
import { Money } from '../../../../core/domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../enterprise/entities/wager-transaction.js';
import { IdempotencyConflictError } from '../errors/idempotency-conflict-error.js';
import { WagerTransactionAlreadyExistsError } from '../errors/wager-transaction-already-exists-error.js';
import type { WagerTransactionsRepository } from '../repositories/wager-transactions-repository.js';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.js';

class InMemoryWagerTransactionsRepository implements WagerTransactionsRepository {
  readonly transactions: WagerTransaction[] = [];
  createCalls = 0;

  async create(transaction: WagerTransaction): Promise<WagerTransaction | null> {
    this.createCalls += 1;
    const existing = this.transactions.find(
      (candidate) =>
        candidate.providerId === transaction.providerId &&
        (candidate.idempotencyKey === transaction.idempotencyKey ||
          candidate.externalTransactionId === transaction.externalTransactionId),
    );

    if (existing) {
      return existing;
    }

    this.transactions.push(transaction);
    return null;
  }

  async findById(transactionId: string): Promise<WagerTransaction | null> {
    return (
      this.transactions.find((transaction) => transaction.id === transactionId) ??
      null
    );
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.transactions.find(
        (transaction) =>
          transaction.providerId === providerId && transaction.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.transactions.find(
        (transaction) =>
          transaction.providerId === providerId &&
          transaction.externalTransactionId === externalTransactionId,
      ) ?? null
    );
  }
}

const request = {
  providerId: 'provider-a',
  externalTransactionId: 'external-tx-1',
  idempotencyKey: 'provider-a:external-tx-1',
  payloadHash: 'sha256-hash',
  walletId: 'ea2e3eb7-8a1e-49a9-84ac-71286d066ccd',
  playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
};

describe('SubmitWagerTransactionUseCase', () => {
  it('creates a pending transaction without applying financial effects', async () => {
    const repository = new InMemoryWagerTransactionsRepository();
    const useCase = new SubmitWagerTransactionUseCase(repository);

    const result = await useCase.execute(request);

    expect(result.idempotentReplay).toBe(false);
    expect(result.transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(result.transaction.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(repository.createCalls).toBe(1);
  });

  it('returns the original transaction for an identical idempotent request', async () => {
    const repository = new InMemoryWagerTransactionsRepository();
    const useCase = new SubmitWagerTransactionUseCase(repository);

    const first = await useCase.execute(request);
    const replay = await useCase.execute(request);

    expect(replay).toEqual({ transaction: first.transaction, idempotentReplay: true });
    expect(repository.createCalls).toBe(1);
  });

  it('rejects reuse of an idempotency key with a different payload', async () => {
    const repository = new InMemoryWagerTransactionsRepository();
    const useCase = new SubmitWagerTransactionUseCase(repository);

    await useCase.execute(request);

    await expect(
      useCase.execute({ ...request, payloadHash: 'different-hash' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(repository.createCalls).toBe(1);
  });

  it('rejects reuse of an external transaction id with another idempotency key', async () => {
    const repository = new InMemoryWagerTransactionsRepository();
    const useCase = new SubmitWagerTransactionUseCase(repository);

    await useCase.execute(request);

    await expect(
      useCase.execute({ ...request, idempotencyKey: 'another-key' }),
    ).rejects.toBeInstanceOf(WagerTransactionAlreadyExistsError);
    expect(repository.createCalls).toBe(1);
  });

  it('replays identical concurrent submissions after the repository resolves a unique conflict', async () => {
    const repository = new InMemoryWagerTransactionsRepository();
    const useCase = new SubmitWagerTransactionUseCase(repository);

    const results = await Promise.all([
      useCase.execute(request),
      useCase.execute(request),
    ]);

    expect(repository.transactions).toHaveLength(1);
    expect(
      results
        .map((result) => result.idempotentReplay)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(results[0].transaction.id).toBe(results[1].transaction.id);
  });

  it('does not suppress repository failures', async () => {
    const repository = new InMemoryWagerTransactionsRepository();
    repository.create = async () => {
      throw new Error('database unavailable');
    };
    const useCase = new SubmitWagerTransactionUseCase(repository);

    await expect(useCase.execute(request)).rejects.toThrow('database unavailable');
  });
});
