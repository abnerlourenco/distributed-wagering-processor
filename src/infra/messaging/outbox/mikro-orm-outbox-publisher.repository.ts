import { EntityManager } from '@mikro-orm/postgresql';

export interface OutboxMessageForPublish {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date | string;
  attempts: number;
  lastErrorCode: string | null;
}

export class MikroOrmOutboxPublisherRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async claimAvailable(limit: number): Promise<OutboxMessageForPublish[]> {
    return this.entityManager
      .getConnection()
      .execute<OutboxMessageForPublish[]>(
        `
        with candidates as (
          select "id"
          from "outbox_messages"
          where (
            ("status" in ('PENDING', 'FAILED') and "available_at" <= current_timestamp)
            or (
              "status" = 'PROCESSING'
              and "locked_at" < current_timestamp - interval '5 minutes'
            )
          )
          and (
            "event_type" <> 'WagerTransactionRequested'
            or not exists (
              select 1
              from "outbox_messages" as earlier
              where earlier."event_type" = 'WagerTransactionRequested'
                and earlier."aggregate_type" = "outbox_messages"."aggregate_type"
                and earlier."aggregate_id" = "outbox_messages"."aggregate_id"
                and (
                  earlier."status" <> 'PUBLISHED'
                  and not (
                    earlier."status" = 'DEAD'
                    and coalesce(earlier."last_error_code", '') like
                      'MAX_PUBLISH_ATTEMPTS_NOT_SENT:%'
                  )
                )
                and (earlier."occurred_at", earlier."id")
                    < ("outbox_messages"."occurred_at", "outbox_messages"."id")
            )
          )
          order by "available_at", "occurred_at", "id"
          limit ?
          for update skip locked
        )
        update "outbox_messages" as messages
        set "status" = 'PROCESSING',
            "attempts" = messages."attempts" + 1,
            "locked_at" = current_timestamp
        from candidates
        where messages."id" = candidates."id"
        returning
          messages."id",
          messages."aggregate_type" as "aggregateType",
          messages."aggregate_id" as "aggregateId",
          messages."event_type" as "eventType",
          messages."payload",
          messages."occurred_at" as "occurredAt",
          messages."attempts",
          messages."last_error_code" as "lastErrorCode"
      `,
        [limit],
      );
  }

  async markPublished(message: OutboxMessageForPublish): Promise<boolean> {
    const updated = await this.entityManager
      .getConnection()
      .execute<Array<{ id: string }>>(
        `
          update "outbox_messages"
          set "status" = 'PUBLISHED',
              "published_at" = current_timestamp,
              "locked_at" = null,
              "last_error_code" = null
          where "id" = ?
            and "status" = 'PROCESSING'
            and "attempts" = ?
          returning "id"
        `,
        [message.id, message.attempts],
      );

    return updated.length === 1;
  }

  async markFailed(
    message: OutboxMessageForPublish,
    retryDelayMs: number,
    errorCode: string,
  ): Promise<boolean> {
    const updated = await this.entityManager
      .getConnection()
      .execute<Array<{ id: string }>>(
        `
          update "outbox_messages"
          set "status" = 'FAILED',
              "available_at" = current_timestamp + (? * interval '1 millisecond'),
              "locked_at" = null,
              "last_error_code" = ?
          where "id" = ?
            and "status" = 'PROCESSING'
            and "attempts" = ?
          returning "id"
        `,
        [retryDelayMs, errorCode, message.id, message.attempts],
      );

    return updated.length === 1;
  }

  async markDead(
    message: OutboxMessageForPublish,
    errorCode: string,
    knownNotSent: boolean,
  ): Promise<boolean> {
    return this.entityManager.transactional(async (entityManager) => {
      const connection = entityManager.getConnection();
      const transactionContext = entityManager.getTransactionContext();
      const updated = await connection.execute<Array<{ id: string }>>(
        `
          update "outbox_messages"
          set "status" = 'DEAD',
              "locked_at" = null,
              "last_error_code" = ?
          where "id" = ?
            and "status" = 'PROCESSING'
            and "attempts" = ?
          returning "id"
        `,
        [errorCode, message.id, message.attempts],
        'all',
        transactionContext,
      );
      if (updated.length !== 1) {
        return false;
      }

      if (knownNotSent && message.eventType === 'WagerTransactionRequested') {
        const transactionId = message.payload.transactionId;
        if (
          typeof transactionId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            transactionId,
          )
        ) {
          await connection.execute(
            `
              update "wager_transactions"
              set "status" = 'FAILED',
                  "failure_code" = 'COMMAND_PUBLISH_ATTEMPTS_EXCEEDED'
              where "id" = ?
                and "status" = 'PENDING'
            `,
            [transactionId],
            'all',
            transactionContext,
          );
        }
      }

      return true;
    });
  }
}
