import type { QueueWagerTransactionsRepository } from '../repositories/queue-wager-transactions-repository.js';
import type { ProcessWagerTransactionRequest } from './process-wager-transaction.js';
import { createWagerTransaction } from './create-wager-transaction.js';

export class QueueWagerTransactionUseCase {
  constructor(
    private readonly transactionsRepository: QueueWagerTransactionsRepository,
  ) {}

  async execute(request: ProcessWagerTransactionRequest) {
    return this.transactionsRepository.enqueue(createWagerTransaction(request));
  }
}
