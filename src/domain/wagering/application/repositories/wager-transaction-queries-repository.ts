import type { WagerTransaction } from '../../enterprise/entities/wager-transaction.js';

export interface WagerTransactionQueriesRepository {
  findById(transactionId: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
}
