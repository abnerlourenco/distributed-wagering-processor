import type { Money } from '../../../../core/domain/money.js';

export interface WalletReconciliation {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface WalletReconciliationRepository {
  reconcile(walletId: string): Promise<WalletReconciliation | null>;
}
