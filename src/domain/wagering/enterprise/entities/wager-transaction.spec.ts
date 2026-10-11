import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../../core/domain/domain-error.js';
import { Money } from '../../../../core/domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

const props = {
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

describe('WagerTransaction', () => {
  it('creates an external transaction as pending', () => {
    const transaction = WagerTransaction.create(props);

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.affectsBalance()).toBe(true);
  });

  it('requires a referenced operation for refunds and rollbacks', () => {
    expect(() =>
      WagerTransaction.create({ ...props, kind: WagerTransactionKind.Refund }),
    ).toThrow(DomainError);
    expect(() =>
      WagerTransaction.create({ ...props, kind: WagerTransactionKind.Rollback }),
    ).toThrow(DomainError);
  });

  it('does not allow zero or negative transaction amounts', () => {
    expect(() =>
      WagerTransaction.create({
        ...props,
        money: Money.zero('BRL'),
      }),
    ).toThrow('must be positive');
  });

  it('marks missing references as pending without processing the transaction', () => {
    const transaction = WagerTransaction.create({
      ...props,
      kind: WagerTransactionKind.Win,
    });

    transaction.markPendingReference();

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.isTerminal()).toBe(false);
  });

  it('marks processed transactions as terminal', () => {
    const transaction = WagerTransaction.create(props);
    const processedAt = new Date();

    transaction.markProcessed(undefined, processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toBe(processedAt);
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.reject('INVALID')).toThrow('Cannot transition terminal');
  });

  it('marks rejected transactions with a stable failure code and prevents further transitions', () => {
    const transaction = WagerTransaction.create(props);

    transaction.reject('INSUFFICIENT_FUNDS');

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.fail('INFRASTRUCTURE_ERROR')).toThrow(
      'Cannot transition terminal',
    );
  });

  it('does not treat LOSS as balance-affecting and recognizes required references', () => {
    const loss = WagerTransaction.create({ ...props, kind: WagerTransactionKind.Loss });
    const refund = WagerTransaction.create({
      ...props,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'external-bet-1',
    });

    expect(loss.affectsBalance()).toBe(false);
    expect(refund.affectsBalance()).toBe(true);
    expect(refund.requiresReference()).toBe(true);
  });

  it('rehydrates an existing transaction without reapplying transitions', () => {
    const transaction = WagerTransaction.create(props);
    transaction.markPendingReference();

    const restored = WagerTransaction.rehydrate({
      ...props,
      id: transaction.id,
      kind: transaction.kind,
      status: transaction.status,
      createdAt: transaction.createdAt,
    });

    expect(restored.status).toBe(WagerTransactionStatus.PendingReference);
  });
});
