import { createHash, randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxEvent } from './outbox-event.schema.js';

export class InboxPayloadConflictError extends Error {
  constructor() {
    super('Inbox message ID was received with a different payload');
    this.name = 'InboxPayloadConflictError';
  }
}

export class MikroOrmInboxConsumerRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async recordReceived(
    consumerName: string,
    source: string,
    message: OutboxEvent,
  ): Promise<{ duplicate: boolean }> {
    const canonicalPayload = JSON.stringify(message, (_, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : value,
    );
    const payloadHash = createHash('sha256')
      .update(canonicalPayload)
      .digest('hex');

    return this.entityManager.transactional(async (entityManager) => {
      const inserted = await entityManager
        .getConnection()
        .execute<Array<{ id: string }>>(
          `
          insert into "inbox_messages" (
            "id", "consumer_name", "source", "message_id", "message_type",
            "payload", "payload_hash", "status", "attempts"
          ) values (?, ?, ?, ?, ?, ?::jsonb, ?, 'RECEIVED', 0)
          on conflict ("consumer_name", "source", "message_id") do nothing
          returning "id"
        `,
          [
            randomUUID(),
            consumerName,
            source,
            message.messageId,
            message.eventType,
            canonicalPayload,
            payloadHash,
          ],
          'all',
          entityManager.getTransactionContext(),
        );

      if (inserted.length === 1) {
        return { duplicate: false };
      }

      const existing = await entityManager
        .getConnection()
        .execute<Array<{ payload_hash: string }>>(
          `
          select "payload_hash"
          from "inbox_messages"
          where "consumer_name" = ?
            and "source" = ?
            and "message_id" = ?
          for update
        `,
          [consumerName, source, message.messageId],
          'all',
          entityManager.getTransactionContext(),
        );

      if (!existing[0]) {
        throw new Error(
          'Inbox conflict occurred but the existing row is missing',
        );
      }
      if (existing[0].payload_hash !== payloadHash) {
        throw new InboxPayloadConflictError();
      }

      return { duplicate: true };
    });
  }
}
