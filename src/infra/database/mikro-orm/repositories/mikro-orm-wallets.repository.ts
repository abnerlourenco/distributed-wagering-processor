import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../../../domain/wallets/application/errors/wallet-already-exists-error.js';
import type { WalletsRepository } from '../../../../domain/wallets/application/repositories/wallets-repository.js';
import { Wallet } from '../../../../domain/wallets/enterprise/entities/wallet.js';
import { Money } from '../../../../core/domain/money.js';
import { WalletEntity } from '../entities/wallet.entity.js';

export class MikroOrmWalletsRepository implements WalletsRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async create(wallet: Wallet): Promise<void> {
    const entity = this.entityManager.create(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });

    try {
      this.entityManager.persist(entity);
      await this.entityManager.flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }

  async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.entityManager.findOne(WalletEntity, { playerId, currency });

    if (!entity) {
      return null;
    }

    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({ amount: entity.balance, currency: entity.currency }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}
