import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../../core/domain/domain-error.js';
import { Money } from '../../../../core/domain/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

const ids = {
  walletId: 'ea2e3eb7-8a1e-49a9-84ac-71286d066ccd',
  transactionId: 'f78008cd-46fc-4b7b-9655-32d40c6a6719',
};

describe('WalletLedgerEntry', () => {
  it('creates and validates a debit entry', () => {
    const entry = WalletLedgerEntry.create({
      ...ids,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  it('creates and validates a credit entry', () => {
    const entry = WalletLedgerEntry.create({
      ...ids,
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '125.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('125.00');
  });

  it('rejects a balanceAfter that does not match the ledger movement', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...ids,
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '80.00', currency: 'BRL' }),
      }),
    ).toThrow('does not match');
  });

  it('rejects a debit that would make the balance negative', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...ids,
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceAfter: Money.zero('BRL'),
      }),
    ).toThrow('cannot be negative');
  });

  it('rejects a zero amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...ids,
        direction: LedgerDirection.Credit,
        money: Money.zero('BRL'),
        balanceBefore: Money.zero('BRL'),
        balanceAfter: Money.zero('BRL'),
      }),
    ).toThrow('must be positive');
  });

  it('rejects balances or amount with mismatched currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...ids,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '25.00', currency: 'USD' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '125.00', currency: 'BRL' }),
      }),
    ).toThrow(DomainError);
  });

  it('rehydrates persisted entries without changing their values', () => {
    const createdAt = new Date('2026-10-11T12:00:00.000Z');
    const entry = WalletLedgerEntry.rehydrate({
      ...ids,
      id: '13c241e7-a3e2-4741-8435-a6e621941ed1',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }),
      createdAt,
    });
    createdAt.setUTCFullYear(2000);
    const exposedCreatedAt = entry.createdAt;
    exposedCreatedAt.setUTCFullYear(2001);

    expect(entry.id).toBe('13c241e7-a3e2-4741-8435-a6e621941ed1');
    expect(entry.createdAt).toEqual(new Date('2026-10-11T12:00:00.000Z'));
    expect(entry.isBalanced()).toBe(true);
  });
});
