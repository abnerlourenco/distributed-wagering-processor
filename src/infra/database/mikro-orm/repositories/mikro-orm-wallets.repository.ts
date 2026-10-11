import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../../../domain/wallets/application/errors/wallet-already-exists-error.js';
import type {
  WalletOpeningLedger,
  WalletsRepository,
} from '../../../../domain/wallets/application/repositories/wallets-repository.js';
import { Wallet } from '../../../../domain/wallets/enterprise/entities/wallet.js';
import { Money } from '../../../../core/domain/money.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';

export class MikroOrmWalletsRepository implements WalletsRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async create(
    wallet: Wallet,
    openingLedger?: WalletOpeningLedger,
  ): Promise<void> {
    try {
      await this.entityManager.transactional(async (entityManager) => {
        const walletEntity = entityManager.create(WalletEntity, {
          id: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toString(),
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });

        entityManager.persist(walletEntity);
        await entityManager.flush();

        if (openingLedger) {
          const { transaction, ledgerEntry } = openingLedger;
          const transactionEntity = entityManager.create(
            WagerTransactionEntity,
            {
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
              status: transaction.status,
              createdAt: transaction.createdAt,
              processedAt: transaction.processedAt,
            },
          );

          entityManager.persist(transactionEntity);
          await entityManager.flush();

          const ledgerEntryEntity = entityManager.create(
            WalletLedgerEntryEntity,
            {
              id: ledgerEntry.id,
              walletId: ledgerEntry.walletId,
              transactionId: ledgerEntry.transactionId,
              direction: ledgerEntry.direction,
              amount: ledgerEntry.money.toString(),
              currency: ledgerEntry.money.currency,
              balanceBefore: ledgerEntry.balanceBefore.toString(),
              balanceAfter: ledgerEntry.balanceAfter.toString(),
              createdAt: ledgerEntry.createdAt,
            },
          );

          entityManager.persist(ledgerEntryEntity);
          await entityManager.flush();
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        const existingWallet = await this.entityManager
          .fork({ clear: true })
          .findOne(WalletEntity, {
            playerId: wallet.playerId,
            currency: wallet.currency,
          });

        if (existingWallet) {
          throw new WalletAlreadyExistsError();
        }
      }

      throw error;
    }
  }

  async findByPlayerIdAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const entity = await this.entityManager.findOne(WalletEntity, {
      playerId,
      currency,
    });

    if (!entity) {
      return null;
    }

    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}
