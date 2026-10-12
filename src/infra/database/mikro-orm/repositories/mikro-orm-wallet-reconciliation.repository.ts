import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../../core/domain/money.js';
import type {
  WalletReconciliation,
  WalletReconciliationRepository,
} from '../../../../domain/wallets/application/repositories/wallet-reconciliation-repository.js';

interface ReconciliationRow {
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  checkedEntries: number;
}

export class MikroOrmWalletReconciliationRepository
  implements WalletReconciliationRepository
{
  constructor(private readonly entityManager: EntityManager) {}

  async reconcile(walletId: string): Promise<WalletReconciliation | null> {
    const rows = await this.entityManager
      .getConnection()
      .execute<ReconciliationRow[]>(
        `select
          wallet."currency" as "currency",
          wallet."balance"::text as "storedBalance",
          coalesce(
            sum(
              case ledger."direction"
                when 'CREDIT' then ledger."amount"
                when 'DEBIT' then -ledger."amount"
              end
            ),
            0
          )::numeric(20, 2)::text as "calculatedBalance",
          count(ledger."id")::int as "checkedEntries"
        from "wallets" as wallet
        left join "wallet_ledger_entries" as ledger
          on ledger."wallet_id" = wallet."id"
        where wallet."id" = ?::uuid
        group by wallet."id"`,
        [walletId],
      );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      storedBalance: Money.from({
        amount: row.storedBalance,
        currency: row.currency,
      }),
      calculatedBalance: Money.from({
        amount: row.calculatedBalance,
        currency: row.currency,
      }),
      checkedEntries: row.checkedEntries,
    };
  }
}
