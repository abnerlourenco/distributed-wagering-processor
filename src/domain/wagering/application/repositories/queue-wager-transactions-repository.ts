import type { Money } from '../../../../core/domain/money.js';
import type { WagerTransaction } from '../../enterprise/entities/wager-transaction.js';

export interface QueueWagerTransactionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
  balance?: Money;
}

export interface QueueWagerTransactionsRepository {
  enqueue(transaction: WagerTransaction): Promise<QueueWagerTransactionResult>;
}
