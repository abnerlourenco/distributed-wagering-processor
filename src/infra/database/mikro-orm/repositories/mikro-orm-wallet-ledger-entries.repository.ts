import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../../core/domain/money.js';
import type {
  WalletLedgerCursorPosition,
  WalletLedgerEntriesRepository,
  WalletLedgerEntryPageItem,
} from '../../../../domain/wallets/application/repositories/wallet-ledger-entries-repository.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../../domain/wallets/enterprise/entities/wallet-ledger-entry.js';

interface WalletLedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  cursorCreatedAt: string;
}

export class MikroOrmWalletLedgerEntriesRepository
  implements WalletLedgerEntriesRepository
{
  constructor(private readonly entityManager: EntityManager) {}

  async findPage(
    walletId: string,
    limit: number,
    before?: WalletLedgerCursorPosition,
  ): Promise<WalletLedgerEntryPageItem[]> {
    const cursorFilter = before
      ? 'and ("created_at", "id") < (?::timestamptz, ?::uuid)'
      : '';
    const params: unknown[] = [walletId];
    if (before) {
      params.push(before.createdAt, before.id);
    }
    params.push(limit);

    const rows = await this.entityManager
      .getConnection()
      .execute<WalletLedgerEntryRow[]>(
        `select
          "id",
          "wallet_id" as "walletId",
          "transaction_id" as "transactionId",
          "direction",
          "amount"::text as "amount",
          "currency",
          "balance_before"::text as "balanceBefore",
          "balance_after"::text as "balanceAfter",
          to_char(
            "created_at" at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as "cursorCreatedAt"
        from "wallet_ledger_entries"
        where "wallet_id" = ?::uuid
        ${cursorFilter}
        order by "created_at" desc, "id" desc
        limit ?`,
        params,
      );

    return rows.map((row) => ({
      entry: WalletLedgerEntry.rehydrate({
        id: row.id,
        walletId: row.walletId,
        transactionId: row.transactionId,
        direction:
          row.direction === LedgerDirection.Debit ||
          row.direction === LedgerDirection.Credit
            ? row.direction
            : this.invalidDirection(row.direction),
        money: Money.from({ amount: row.amount, currency: row.currency }),
        balanceBefore: Money.from({
          amount: row.balanceBefore,
          currency: row.currency,
        }),
        balanceAfter: Money.from({
          amount: row.balanceAfter,
          currency: row.currency,
        }),
        createdAt: new Date(row.cursorCreatedAt),
      }),
      cursorCreatedAt: row.cursorCreatedAt,
    }));
  }

  private invalidDirection(direction: string): never {
    throw new Error(`Unsupported persisted ledger direction: ${direction}`);
  }
}
