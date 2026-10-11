import { describe, expect, it } from 'vitest';
import { DomainError } from './domain-error.js';
import { Money } from './money.js';

describe('Money', () => {
  it('serializes values with exactly two decimal places', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });

    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(money.toString()).toBe('25.00');
  });

  it.each(['', '25', '25.0', '25.000', '-25.00', '1e2', 'NaN', 'Infinity'])(
    'rejects invalid amount %s',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(DomainError);
    },
  );

  it('performs exact arithmetic without JavaScript numbers', () => {
    const result = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );

    expect(result.toString()).toBe('0.30');
  });

  it('supports negative values produced internally by subtraction and negation', () => {
    const value = Money.from({ amount: '10.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '15.00', currency: 'BRL' }),
    );

    expect(value.isNegative()).toBe(true);
    expect(value.negate().toString()).toBe('5.00');
  });

  it('rejects operations between different currencies', () => {
    const brl = Money.zero('BRL');
    const usd = Money.zero('USD');

    expect(() => brl.add(usd)).toThrow('same currency');
  });
});
