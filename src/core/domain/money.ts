import { Decimal } from 'decimal.js';
import { DomainError } from './domain-error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const MoneyDecimal = Decimal.clone({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
});

const MONEY_AMOUNT_PATTERN = /^\d{1,18}\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    Money.assertCurrency(props.currency);

    if (!MONEY_AMOUNT_PATTERN.test(props.amount)) {
      throw new DomainError(
        'Money amount must be a non-negative decimal string with exactly two decimal places',
      );
    }

    return Money.fromDecimal(new MoneyDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private static fromDecimal(value: Decimal, currency: string): Money {
    Money.assertCurrency(currency);

    if (!MONEY_AMOUNT_PATTERN.test(value.abs().toFixed(2))) {
      throw new DomainError('Money amount exceeds the supported precision');
    }

    return new Money(value, currency);
  }

  private static assertCurrency(currency: string): void {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new DomainError('Money currency must be a three-letter uppercase ISO-4217 code');
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('Money operations require the same currency');
    }
  }
}
