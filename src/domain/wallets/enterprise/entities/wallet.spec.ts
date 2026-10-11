import { describe, expect, it } from 'vitest';
import { Money } from '../../../../core/domain/money.js';
import { Wallet } from './wallet.js';

describe('Wallet', () => {
  it('opens with a zero balance and version one', () => {
    const wallet = Wallet.open({
      id: 'd906926b-637d-4f4d-9c2a-e1542ed4d1be',
      playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
      currency: 'BRL',
    });

    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
  });

  it('changes the balance and version on credit and debit', () => {
    const wallet = Wallet.open({ playerId: 'player-1', currency: 'BRL' });

    wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }));
    wallet.debit(Money.from({ amount: '4.00', currency: 'BRL' }));

    expect(wallet.balance.toString()).toBe('6.00');
    expect(wallet.version).toBe(3);
  });

  it('does not allow a debit greater than the available balance', () => {
    const wallet = Wallet.open({ playerId: 'player-1', currency: 'BRL' });

    expect(() => wallet.debit(Money.from({ amount: '0.01', currency: 'BRL' }))).toThrow(
      'insufficient balance',
    );
  });
});
