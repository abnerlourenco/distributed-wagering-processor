import { createHash } from 'node:crypto';
import type { Money } from '../../../../core/domain/money.js';
import { WagerTransactionKind } from '../../enterprise/entities/wager-transaction.js';
import { WagerTransaction } from '../../enterprise/entities/wager-transaction.js';
import type { ProcessWagerTransactionsRepository } from '../repositories/process-wager-transactions-repository.js';

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
  constructor(
    private readonly transactionsRepository: ProcessWagerTransactionsRepository,
  ) {}

  async execute(request: ProcessBetRequest) {
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          providerId: request.providerId,
          externalTransactionId: request.externalTransactionId,
          walletId: request.walletId,
          playerId: request.playerId,
          roundId: request.roundId,
          gameId: request.gameId,
          kind: WagerTransactionKind.Bet,
          amount: request.money.toString(),
          currency: request.money.currency,
        }),
      )
      .digest('hex');
    const transaction = WagerTransaction.create({
      ...request,
      kind: WagerTransactionKind.Bet,
      payloadHash,
    });

    return this.transactionsRepository.processBet(transaction);
  }
}
