import type { Money } from '../../../../core/domain/money.js';
import type { WagerTransaction } from '../../enterprise/entities/wager-transaction.js';

export interface ProcessWagerTransactionResult {
  transaction: WagerTransaction;
  balance: Money;
  idempotentReplay: boolean;
}

export interface ProcessWagerTransactionsRepository {
  process(
    transaction: WagerTransaction,
  ): Promise<ProcessWagerTransactionResult>;
}
