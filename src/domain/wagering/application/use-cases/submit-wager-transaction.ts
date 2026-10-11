import { IdempotencyConflictError } from '../errors/idempotency-conflict-error.js';
import { WagerTransactionAlreadyExistsError } from '../errors/wager-transaction-already-exists-error.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../enterprise/entities/wager-transaction.js';
import type { WagerTransactionsRepository } from '../repositories/wager-transactions-repository.js';

export type SubmitWagerTransactionRequest = Omit<CreateWagerTransactionProps, 'id' | 'createdAt'>;

export interface SubmitWagerTransactionResponse {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export class SubmitWagerTransactionUseCase {
  constructor(private readonly transactionsRepository: WagerTransactionsRepository) {}

  async execute(
    request: SubmitWagerTransactionRequest,
  ): Promise<SubmitWagerTransactionResponse> {
    const byIdempotencyKey = await this.transactionsRepository.findByProviderAndIdempotencyKey(
      request.providerId,
      request.idempotencyKey,
    );

    if (byIdempotencyKey) {
      if (!byIdempotencyKey.matchesPayload(request.payloadHash)) {
        throw new IdempotencyConflictError();
      }

      return { transaction: byIdempotencyKey, idempotentReplay: true };
    }

    const byExternalId =
      await this.transactionsRepository.findByProviderAndExternalTransactionId(
        request.providerId,
        request.externalTransactionId,
      );

    if (byExternalId) {
      throw new WagerTransactionAlreadyExistsError();
    }

    const transaction = WagerTransaction.create(request);
    const existingTransaction = await this.transactionsRepository.create(transaction);

    if (!existingTransaction) {
      return { transaction, idempotentReplay: false };
    }

    if (existingTransaction.idempotencyKey !== request.idempotencyKey) {
      throw new WagerTransactionAlreadyExistsError();
    }

    if (!existingTransaction.matchesPayload(request.payloadHash)) {
      throw new IdempotencyConflictError();
    }

    return { transaction: existingTransaction, idempotentReplay: true };
  }
}
