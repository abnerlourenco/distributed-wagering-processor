import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Money } from '../../../../core/domain/money.js';
import type { ProcessWagerTransactionsRepository } from '../repositories/process-wager-transactions-repository.js';
import { ProcessBetUseCase } from './process-bet.js';

describe('ProcessBetUseCase', () => {
  it('creates a BET with a deterministic business payload hash', async () => {
    const requests: string[] = [];
    const repository: ProcessWagerTransactionsRepository = {
      async processBet(transaction) {
        requests.push(transaction.payloadHash);
        return {
          transaction,
          balance: Money.from({ amount: '75.00', currency: 'BRL' }),
          idempotentReplay: false,
        };
      },
    };
    const useCase = new ProcessBetUseCase(repository);
    const request = {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-1',
      idempotencyKey: 'provider-a:transaction-1',
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    };

    const result = await useCase.execute(request);
    await useCase.execute(request);

    expect(result.transaction.kind).toBe('BET');
    expect(requests[0]).toBe(requests[1]);
    expect(requests[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the payload hash when the business amount changes', async () => {
    const hashes: string[] = [];
    const useCase = new ProcessBetUseCase({
      async processBet(transaction) {
        hashes.push(transaction.payloadHash);
        return {
          transaction,
          balance: Money.zero('BRL'),
          idempotentReplay: false,
        };
      },
    });
    const request = {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-1',
      idempotencyKey: 'provider-a:transaction-1',
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    };

    await useCase.execute(request);
    await useCase.execute({
      ...request,
      money: Money.from({ amount: '26.00', currency: 'BRL' }),
    });

    expect(hashes[0]).not.toBe(hashes[1]);
  });
});
