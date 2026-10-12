import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionKind } from '../../../../domain/wagering/enterprise/entities/wager-transaction.js';

export interface PendingReferenceRetry {
  id: string;
  createdAt: Date | string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string;
}

export class MikroOrmPendingReferenceRetriesRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async claimDue(limit: number): Promise<PendingReferenceRetry[]> {
    return this.entityManager.transactional(async (entityManager) => {
      const transactionContext = entityManager.getTransactionContext();
      return entityManager.getConnection().execute<PendingReferenceRetry[]>(
        `
          with candidates as (
            select "id"
            from "wager_transactions"
            where "status" = 'PENDING_REFERENCE'
              and "reference_next_attempt_at" <= current_timestamp
              and "kind" in ('WIN', 'REFUND', 'ROLLBACK')
            order by "reference_next_attempt_at", "id"
            limit ?
            for update skip locked
          )
          update "wager_transactions" as transactions
          set "reference_next_attempt_at" =
            current_timestamp + interval '5 minutes'
          from candidates
          where transactions."id" = candidates."id"
          returning
            transactions."id",
            transactions."created_at" as "createdAt",
            transactions."provider_id" as "providerId",
            transactions."external_transaction_id" as "externalTransactionId",
            transactions."idempotency_key" as "idempotencyKey",
            transactions."wallet_id" as "walletId",
            transactions."player_id" as "playerId",
            transactions."round_id" as "roundId",
            transactions."game_id" as "gameId",
            transactions."kind",
            transactions."amount",
            transactions."currency",
            transactions."reference_external_transaction_id"
              as "referenceExternalTransactionId"
        `,
        [limit],
        'all',
        transactionContext,
      );
    });
  }
}
