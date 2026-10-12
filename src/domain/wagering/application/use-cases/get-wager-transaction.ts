import { WagerTransactionNotFoundError } from '../errors/wager-transaction-not-found-error.js';
import type { WagerTransactionQueriesRepository } from '../repositories/wager-transaction-queries-repository.js';

export class GetWagerTransactionUseCase {
  constructor(
    private readonly transactionsRepository: WagerTransactionQueriesRepository,
  ) {}

  async findById(transactionId: string) {
    const transaction =
      await this.transactionsRepository.findById(transactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError();
    }

    return { transaction };
  }

  async findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ) {
    const transaction =
      await this.transactionsRepository.findByProviderAndExternalTransactionId(
        providerId,
        externalTransactionId,
      );
    if (!transaction) {
      throw new WagerTransactionNotFoundError();
    }

    return { transaction };
  }
}
