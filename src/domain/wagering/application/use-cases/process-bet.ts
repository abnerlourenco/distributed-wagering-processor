import type { Money } from '../../../../core/domain/money.js';
import { WagerTransactionKind } from '../../enterprise/entities/wager-transaction.js';
import type { ProcessWagerTransactionsRepository } from '../repositories/process-wager-transactions-repository.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.js';

export interface ProcessBetRequest {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  money: Money;
}

export class ProcessBetUseCase {
  private readonly processTransaction: ProcessWagerTransactionUseCase;

  constructor(
    transactionsRepository: ProcessWagerTransactionsRepository,
  ) {
    this.processTransaction = new ProcessWagerTransactionUseCase(
      transactionsRepository,
    );
  }

  async execute(request: ProcessBetRequest) {
    return this.processTransaction.execute({
      ...request,
      kind: WagerTransactionKind.Bet,
    });
  }
}
