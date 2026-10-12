import { describe, expect, it } from 'vitest';
import { outboxEventSchema } from './outbox-event.schema.js';

describe('outboxEventSchema', () => {
  it('accepts a terminal event for an unresolved reference', () => {
    const event = {
      messageId: 'a1ecf4c4-2106-4f79-90cf-58055b9fb8b4',
      aggregateType: 'wager-transaction',
      aggregateId: 'a1ecf4c4-2106-4f79-90cf-58055b9fb8b4',
      eventType: 'WagerTransactionRejected',
      occurredAt: '2026-10-12T00:00:00.000Z',
      payload: {
        transactionId: 'a1ecf4c4-2106-4f79-90cf-58055b9fb8b4',
        providerId: 'provider-a',
        externalTransactionId: 'win-1',
        walletId: '0972db18-d0e7-4d3a-bc30-9ae6df014ba6',
        playerId: 'd59a3305-ebd6-412a-8cda-6d4a7e7fc774',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'WIN',
        amount: '5.00',
        currency: 'BRL',
        referenceExternalTransactionId: 'missing-bet',
        failureCode: 'REFERENCE_TRANSACTION_NOT_FOUND',
        rejectedAt: '2026-10-12T00:00:00.000Z',
      },
    };

    expect(outboxEventSchema.parse(event)).toEqual(event);
  });

  it('continues to accept processed wager events', () => {
    const event = {
      messageId: 'a1ecf4c4-2106-4f79-90cf-58055b9fb8b4',
      aggregateType: 'wager-transaction',
      aggregateId: 'a1ecf4c4-2106-4f79-90cf-58055b9fb8b4',
      eventType: 'WagerTransactionProcessed',
      occurredAt: '2026-10-12T00:00:00.000Z',
      payload: {
        transactionId: 'a1ecf4c4-2106-4f79-90cf-58055b9fb8b4',
        providerId: 'provider-a',
        externalTransactionId: 'bet-1',
        walletId: '0972db18-d0e7-4d3a-bc30-9ae6df014ba6',
        playerId: 'd59a3305-ebd6-412a-8cda-6d4a7e7fc774',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        amount: '5.00',
        currency: 'BRL',
        referenceTransactionId: null,
        resultingBalance: '95.00',
        processedAt: '2026-10-12T00:00:00.000Z',
      },
    };

    expect(outboxEventSchema.parse(event)).toEqual(event);
  });
});
