import { z } from 'zod';
import { WagerTransactionKind } from '../../../domain/wagering/enterprise/entities/wager-transaction.js';

export const wagerCommandSchema = z
  .object({
    messageId: z.string().trim().min(1).max(255),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.iso.datetime(),
    data: z
      .object({
        transactionId: z.uuid().optional(),
        createdAt: z.iso.datetime().optional(),
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
        money: z
          .object({
            amount: z.string().regex(/^\d{1,18}\.\d{2}$/),
            currency: z.string().regex(/^[A-Z]{3}$/),
          })
          .strict(),
        referenceExternalTransactionId: z
          .string()
          .max(255)
          .nullable()
          .optional(),
      })
      .strict(),
  })
  .strict();

export type WagerCommand = z.infer<typeof wagerCommandSchema>;
