import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../../core/domain/money.js';
import type { WagerTransactionsRepository } from '../../../../domain/wagering/application/repositories/wager-transactions-repository.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../../../../domain/wagering/enterprise/entities/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';

export class MikroOrmWagerTransactionsRepository implements WagerTransactionsRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async create(transaction: WagerTransaction): Promise<WagerTransaction | null> {
    const entityManager = this.entityManager.fork({ clear: true });

    const entity = entityManager.create(WagerTransactionEntity, {
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
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    });

    try {
      entityManager.persist(entity);

      await entityManager.flush();

      return null;
    } catch (error) {

      if (!(error instanceof UniqueConstraintViolationException)) {
        throw error;
      }

      const lookupEntityManager = this.entityManager.fork({ clear: true });
      
      const existing =
        (await lookupEntityManager.findOne(WagerTransactionEntity, {
          providerId: transaction.providerId,
          idempotencyKey: transaction.idempotencyKey,
        })) ??
        (await lookupEntityManager.findOne(WagerTransactionEntity, {
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
        }));

      if (!existing) {
        throw error;
      }

      return MikroOrmWagerTransactionsRepository.toDomain(existing);
    }
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.entityManager.findOne(WagerTransactionEntity, {
      providerId,
      idempotencyKey,
    });

    return entity ? MikroOrmWagerTransactionsRepository.toDomain(entity) : null;
  }

  async findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.entityManager.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });

    return entity ? MikroOrmWagerTransactionsRepository.toDomain(entity) : null;
  }

  private static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const state: WagerTransactionState = {
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: MikroOrmWagerTransactionsRepository.toKind(entity.kind),
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      createdAt: entity.createdAt,
      status: MikroOrmWagerTransactionsRepository.toStatus(entity.status),
      referenceTransactionId: entity.referenceTransactionId,
      failureCode: entity.failureCode,
      processedAt: entity.processedAt,
    };

    return WagerTransaction.rehydrate(state);
  }

  private static toKind(value: string): WagerTransactionKind {
    switch (value) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return value;
      default:
        throw new Error(`Unknown wager transaction kind stored in database: ${value}`);
    }
  }

  private static toStatus(value: string): WagerTransactionStatus {
    switch (value) {
      case WagerTransactionStatus.Pending:
      case WagerTransactionStatus.PendingReference:
      case WagerTransactionStatus.Processed:
      case WagerTransactionStatus.Rejected:
      case WagerTransactionStatus.Failed:
        return value;
      default:
        throw new Error(`Unknown wager transaction status stored in database: ${value}`);
    }
  }
}
