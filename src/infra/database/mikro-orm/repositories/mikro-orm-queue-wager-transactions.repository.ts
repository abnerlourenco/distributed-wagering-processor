import { randomUUID } from 'node:crypto';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../../core/domain/money.js';
import { IdempotencyConflictError } from '../../../../domain/wagering/application/errors/idempotency-conflict-error.js';
import { WagerTransactionAlreadyExistsError } from '../../../../domain/wagering/application/errors/wager-transaction-already-exists-error.js';
import type {
  QueueWagerTransactionResult,
  QueueWagerTransactionsRepository,
} from '../../../../domain/wagering/application/repositories/queue-wager-transactions-repository.js';
import type { WagerTransaction } from '../../../../domain/wagering/enterprise/entities/wager-transaction.js';
import { WalletNotFoundError } from '../../../../domain/wallets/application/errors/wallet-not-found-error.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { MikroOrmWagerTransactionsRepository } from './mikro-orm-wager-transactions.repository.js';

export class MikroOrmQueueWagerTransactionsRepository implements QueueWagerTransactionsRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async enqueue(
    transaction: WagerTransaction,
  ): Promise<QueueWagerTransactionResult> {
    try {
      return await this.entityManager.transactional(async (entityManager) => {
        const existing = await entityManager.findOne(WagerTransactionEntity, {
          providerId: transaction.providerId,
          idempotencyKey: transaction.idempotencyKey,
        });
        if (existing) {
          return this.replay(existing, transaction);
        }

        const externalTransaction = await entityManager.findOne(
          WagerTransactionEntity,
          {
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
          },
        );
        if (externalTransaction) {
          throw new WagerTransactionAlreadyExistsError();
        }

        const wallet = await entityManager.findOne(WalletEntity, {
          id: transaction.walletId,
          playerId: transaction.playerId,
          currency: transaction.money.currency,
        });
        if (!wallet) {
          throw new WalletNotFoundError();
        }

        entityManager.persist(
          entityManager.create(WagerTransactionEntity, {
            id: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            payloadHash: transaction.payloadHash,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind,
            amount: transaction.money.toString(),
            currency: transaction.money.currency,
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
            status: transaction.status,
            createdAt: transaction.createdAt,
          }),
        );
        entityManager.persist(
          entityManager.create(OutboxMessageEntity, {
            id: randomUUID(),
            deduplicationKey: `wager-transaction:${transaction.id}:requested`,
            aggregateType: 'wager-wallet',
            aggregateId: transaction.walletId,
            eventType: 'WagerTransactionRequested',
            payload: {
              transactionId: transaction.id,
              createdAt: transaction.createdAt.toISOString(),
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              idempotencyKey: transaction.idempotencyKey,
              walletId: transaction.walletId,
              playerId: transaction.playerId,
              roundId: transaction.roundId,
              gameId: transaction.gameId,
              kind: transaction.kind,
              amount: transaction.money.toString(),
              currency: transaction.money.currency,
              referenceExternalTransactionId:
                transaction.referenceExternalTransactionId ?? null,
            },
            status: 'PENDING',
            attempts: 0,
            availableAt: transaction.createdAt,
            occurredAt: transaction.createdAt,
          }),
        );
        await entityManager.flush();

        return { transaction, idempotentReplay: false };
      });
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) {
        throw error;
      }

      const lookup = this.entityManager.fork({ clear: true });
      const existing =
        (await lookup.findOne(WagerTransactionEntity, {
          providerId: transaction.providerId,
          idempotencyKey: transaction.idempotencyKey,
        })) ??
        (await lookup.findOne(WagerTransactionEntity, {
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
        }));

      if (!existing) {
        throw error;
      }
      return this.replay(existing, transaction);
    }
  }

  private replay(
    existing: WagerTransactionEntity,
    request: WagerTransaction,
  ): QueueWagerTransactionResult {
    if (existing.idempotencyKey !== request.idempotencyKey) {
      throw new WagerTransactionAlreadyExistsError();
    }
    if (existing.payloadHash !== request.payloadHash) {
      throw new IdempotencyConflictError();
    }

    return {
      transaction: MikroOrmWagerTransactionsRepository.toDomain(existing),
      idempotentReplay: true,
      ...(existing.resultingBalance
        ? {
            balance: Money.from({
              amount: existing.resultingBalance,
              currency: existing.currency,
            }),
          }
        : {}),
    };
  }
}
