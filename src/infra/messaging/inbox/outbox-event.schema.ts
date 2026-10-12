import { z } from 'zod';

const eventEnvelopeSchema = z.object({
  messageId: z.uuid(),
  aggregateType: z.string().trim().min(1).max(128),
  aggregateId: z.string().trim().min(1).max(255),
  occurredAt: z.iso.datetime(),
});

const wagerKinds = z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);
const monetaryAmount = z.string().regex(/^\d{1,18}\.\d{2}$/);

export const outboxEventSchema = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema
    .extend({
      eventType: z.literal('WagerTransactionProcessed'),
      payload: z
        .object({
          transactionId: z.uuid(),
          providerId: z.string().trim().min(1).max(255),
          externalTransactionId: z.string().trim().min(1).max(255),
          walletId: z.uuid(),
          playerId: z.uuid(),
          roundId: z.string().trim().min(1).max(255),
          gameId: z.string().trim().min(1).max(255),
          kind: wagerKinds,
          amount: monetaryAmount,
          currency: z.string().regex(/^[A-Z]{3}$/),
          referenceTransactionId: z.uuid().nullable(),
          resultingBalance: monetaryAmount,
          processedAt: z.iso.datetime(),
        })
        .strict(),
    })
    .strict(),
  eventEnvelopeSchema
    .extend({
      eventType: z.literal('WagerTransactionRejected'),
      payload: z
        .object({
          transactionId: z.uuid(),
          providerId: z.string().trim().min(1).max(255),
          externalTransactionId: z.string().trim().min(1).max(255),
          walletId: z.uuid(),
          playerId: z.uuid(),
          roundId: z.string().trim().min(1).max(255),
          gameId: z.string().trim().min(1).max(255),
          kind: wagerKinds,
          amount: monetaryAmount,
          currency: z.string().regex(/^[A-Z]{3}$/),
          referenceExternalTransactionId: z.string().trim().min(1).max(255),
          failureCode: z.literal('REFERENCE_TRANSACTION_NOT_FOUND'),
          rejectedAt: z.iso.datetime(),
        })
        .strict(),
    })
    .strict(),
]);

export type OutboxEvent = z.infer<typeof outboxEventSchema>;
