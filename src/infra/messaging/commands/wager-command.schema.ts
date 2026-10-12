import { z } from 'zod';
import { WagerTransactionKind } from '../../../domain/wagering/enterprise/entities/wager-transaction.js';

export const wagerCommandSchema = z
  .object({
    messageId: z.uuid(),
    aggregateType: z.literal('wager-wallet'),
    aggregateId: z.uuid(),
    eventType: z.literal('WagerTransactionRequested'),
    occurredAt: z.iso.datetime(),
    payload: z
      .object({
        transactionId: z.uuid(),
        createdAt: z.iso.datetime(),
        providerId: z.string().trim().min(1).max(255),
        externalTransactionId: z.string().trim().min(1).max(255),
        idempotencyKey: z.string().trim().min(1).max(255),
        walletId: z.uuid(),
        playerId: z.uuid(),
        roundId: z.string().trim().min(1).max(255),
        gameId: z.string().trim().min(1).max(255),
        kind: z.enum([
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Loss,
          WagerTransactionKind.Refund,
          WagerTransactionKind.Rollback,
        ]),
        amount: z.string().regex(/^\d{1,18}\.\d{2}$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
        referenceExternalTransactionId: z.string().max(255).nullable(),
      })
      .strict(),
  })
  .strict()
  .refine((message) => message.aggregateId === message.payload.walletId, {
    path: ['aggregateId'],
    message: 'Wager command aggregate must match its wallet ID',
  });

export type WagerCommand = z.infer<typeof wagerCommandSchema>;
