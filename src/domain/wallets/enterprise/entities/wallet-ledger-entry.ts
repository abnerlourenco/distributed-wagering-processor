import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../../core/domain/domain-error.js';
import { Money } from '../../../../core/domain/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateWalletLedgerEntryProps {
  id?: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface WalletLedgerEntryState extends Omit<CreateWalletLedgerEntryProps, 'createdAt'> {
  id: string;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this._createdAt = new Date(createdAt.getTime());
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertRequired('walletId', props.walletId);
    WalletLedgerEntry.assertRequired('transactionId', props.transactionId);

    if (!props.money.isPositive()) {
      throw new DomainError('Ledger entry amount must be positive');
    }

    const expectedBalance =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.direction === LedgerDirection.Credit
          ? props.balanceBefore.add(props.money)
          : undefined;

    if (!expectedBalance) {
      throw new DomainError(`Unsupported ledger direction: ${String(props.direction)}`);
    }

    if (
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative() ||
      expectedBalance.isNegative()
    ) {
      throw new DomainError('Ledger balances cannot be negative');
    }

    if (!expectedBalance.equals(props.balanceAfter)) {
      throw new DomainError('Ledger entry balance does not match its direction and amount');
    }

    return new WalletLedgerEntry(
      props.id ?? randomUUID(),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
    );
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    if (![LedgerDirection.Debit, LedgerDirection.Credit].includes(this.direction)) {
      return false;
    }

    const expectedBalance =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }

  private static assertRequired(field: string, value: string): void {
    if (!value.trim()) {
      throw new DomainError(`Ledger entry ${field} is required`);
    }
  }
}
