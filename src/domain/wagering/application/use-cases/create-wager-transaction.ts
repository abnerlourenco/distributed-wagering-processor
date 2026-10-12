import { createHash } from 'node:crypto';
import { WagerTransaction } from '../../enterprise/entities/wager-transaction.js';
import type { ProcessWagerTransactionRequest } from './process-wager-transaction.js';

export function createWagerTransaction(
  request: ProcessWagerTransactionRequest,
): WagerTransaction {
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

  return WagerTransaction.create({
    ...request,
    id: request.transactionId,
    payloadHash,
  });
}
