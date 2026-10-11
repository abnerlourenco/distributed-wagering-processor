import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../../core/domain/domain-error.js';
import { Money } from '../../../../core/domain/money.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id?: string; playerId: string; currency: string }): Wallet {
    if (!props.playerId) {
      throw new DomainError('Wallet player id is required');
    }

    const balance = Money.zero(props.currency);
    const now = new Date();

    return new Wallet(
      props.id ?? randomUUID(),
      props.playerId,
      balance.currency,
      balance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money): void {
    this.assertSameCurrency(amount);

    if (amount.isNegative() || amount.isZero()) {
      throw new DomainError('Wallet debit amount must be positive');
    }

    if (this._balance.isLessThan(amount)) {
      throw new DomainError('Wallet has insufficient balance');
    }

    this.changeBalance(this._balance.subtract(amount));
  }

  credit(amount: Money): void {
    this.assertSameCurrency(amount);

    if (amount.isNegative() || amount.isZero()) {
      throw new DomainError('Wallet credit amount must be positive');
    }

    this.changeBalance(this._balance.add(amount));
  }

  private changeBalance(balance: Money): void {
    this._balance = balance;
    this._version += 1;
    this._updatedAt = new Date();
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new DomainError('Wallet operation currency must match wallet currency');
    }
  }
}
