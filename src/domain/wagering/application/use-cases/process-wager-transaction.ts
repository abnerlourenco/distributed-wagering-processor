import type { Money } from '../../../../core/domain/money.js';
import { WagerTransactionKind } from '../../enterprise/entities/wager-transaction.js';
import type { ProcessWagerTransactionsRepository } from '../repositories/process-wager-transactions-repository.js';
import { createWagerTransaction } from './create-wager-transaction.js';

export interface ProcessWagerTransactionRequest {
  transactionId?: string;
  createdAt?: Date;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind:
    | WagerTransactionKind.Bet
    | WagerTransactionKind.Win
    | WagerTransactionKind.Loss
    | WagerTransactionKind.Refund
    | WagerTransactionKind.Rollback;
  money: Money;
  referenceExternalTransactionId?: string;
}

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly transactionsRepository: ProcessWagerTransactionsRepository,
  ) {}

  async execute(request: ProcessWagerTransactionRequest) {
    return this.transactionsRepository.process(createWagerTransaction(request));
  }
}
