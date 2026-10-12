import { createHash } from 'node:crypto';
import type { Money } from '../../../../core/domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../enterprise/entities/wager-transaction.js';
import type { ProcessWagerTransactionsRepository } from '../repositories/process-wager-transactions-repository.js';

export interface ProcessWagerTransactionRequest {
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
    | WagerTransactionKind.Refund;
  money: Money;
  referenceExternalTransactionId?: string;
}

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly transactionsRepository: ProcessWagerTransactionsRepository,
  ) {}

  async execute(request: ProcessWagerTransactionRequest) {
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          providerId: request.providerId,
          externalTransactionId: request.externalTransactionId,
          walletId: request.walletId,
          playerId: request.playerId,
          roundId: request.roundId,
          gameId: request.gameId,
          kind: request.kind,
          amount: request.money.toString(),
          currency: request.money.currency,
          ...(request.referenceExternalTransactionId
            ? {
                referenceExternalTransactionId:
                  request.referenceExternalTransactionId,
              }
            : {}),
        }),
      )
      .digest('hex');
    const transaction = WagerTransaction.create({
      ...request,
      payloadHash,
    });

    return this.transactionsRepository.process(transaction);
  }
}
