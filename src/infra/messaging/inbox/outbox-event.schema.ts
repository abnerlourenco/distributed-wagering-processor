import { z } from 'zod';

export const outboxEventSchema = z
  .object({
    messageId: z.uuid(),
    aggregateType: z.string().trim().min(1).max(128),
    aggregateId: z.string().trim().min(1).max(255),
    eventType: z.literal('WagerTransactionProcessed'),
    occurredAt: z.iso.datetime(),
    payload: z
      .object({
        transactionId: z.uuid(),
        providerId: z.string().trim().min(1).max(255),
        externalTransactionId: z.string().trim().min(1).max(255),
        walletId: z.uuid(),
        playerId: z.uuid(),
        roundId: z.string().trim().min(1).max(255),
        gameId: z.string().trim().min(1).max(255),
        kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
        amount: z.string().regex(/^\d{1,18}\.\d{2}$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
        referenceTransactionId: z.uuid().nullable(),
        resultingBalance: z.string().regex(/^\d{1,18}\.\d{2}$/),
        processedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();

export type OutboxEvent = z.infer<typeof outboxEventSchema>;
