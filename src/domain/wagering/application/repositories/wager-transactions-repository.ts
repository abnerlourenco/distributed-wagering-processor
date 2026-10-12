import type { WagerTransaction } from '../../enterprise/entities/wager-transaction.js';

export interface WagerTransactionsRepository {
  create(transaction: WagerTransaction): Promise<WagerTransaction | null>;
  findById(transactionId: string): Promise<WagerTransaction | null>;
  findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
  findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
}
