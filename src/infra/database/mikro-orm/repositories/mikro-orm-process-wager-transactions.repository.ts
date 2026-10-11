import {
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { DomainError } from '../../../../core/domain/domain-error.js';
import { Money } from '../../../../core/domain/money.js';
import { IdempotencyConflictError } from '../../../../domain/wagering/application/errors/idempotency-conflict-error.js';
import { WagerTransactionAlreadyExistsError } from '../../../../domain/wagering/application/errors/wager-transaction-already-exists-error.js';
import type {
  ProcessWagerTransactionResult,
  ProcessWagerTransactionsRepository,
} from '../../../../domain/wagering/application/repositories/process-wager-transactions-repository.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../../domain/wagering/enterprise/entities/wager-transaction.js';
import { InsufficientWalletBalanceError } from '../../../../domain/wallets/enterprise/errors/insufficient-wallet-balance-error.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../../domain/wallets/enterprise/entities/wallet-ledger-entry.js';
import { Wallet } from '../../../../domain/wallets/enterprise/entities/wallet.js';
import { WalletNotFoundError } from '../../../../domain/wallets/application/errors/wallet-not-found-error.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { MikroOrmWagerTransactionsRepository } from './mikro-orm-wager-transactions.repository.js';

export class MikroOrmProcessWagerTransactionsRepository
  implements ProcessWagerTransactionsRepository
{
  constructor(private readonly entityManager: EntityManager) {}

  async processBet(
    transaction: WagerTransaction,
  ): Promise<ProcessWagerTransactionResult> {
    if (transaction.kind !== WagerTransactionKind.Bet) {
      throw new DomainError('This repository only processes BET transactions');
    }

    try {
      return await this.entityManager.transactional(async (entityManager) => {
        const existing = await entityManager.findOne(WagerTransactionEntity, {
          providerId: transaction.providerId,
          idempotencyKey: transaction.idempotencyKey,
        });
        if (existing) {
          return this.replay(existing, transaction);
        }

        const walletEntity = await entityManager.findOne(
          WalletEntity,
          { id: transaction.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (
          !walletEntity ||
          walletEntity.playerId !== transaction.playerId ||
          walletEntity.currency !== transaction.money.currency
        ) {
          throw new WalletNotFoundError();
        }

        const concurrentReplay = await entityManager.findOne(
          WagerTransactionEntity,
          {
            providerId: transaction.providerId,
            idempotencyKey: transaction.idempotencyKey,
          },
        );
        if (concurrentReplay) {
          return this.replay(concurrentReplay, transaction);
        }

        const existingExternalTransaction = await entityManager.findOne(
          WagerTransactionEntity,
          {
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
          },
        );
        if (existingExternalTransaction) {
          throw new WagerTransactionAlreadyExistsError();
        }

        const wallet = Wallet.rehydrate({
          id: walletEntity.id,
          playerId: walletEntity.playerId,
          currency: walletEntity.currency,
          balance: Money.from({
            amount: walletEntity.balance,
            currency: walletEntity.currency,
          }),
          version: walletEntity.version,
          createdAt: walletEntity.createdAt,
          updatedAt: walletEntity.updatedAt,
        });

        let ledgerEntry: WalletLedgerEntry | undefined;
        let resultBalance = wallet.balance;
        try {
          wallet.debit(transaction.money);
          resultBalance = wallet.balance;
          const processedAt = new Date();
          transaction.markProcessed(undefined, processedAt);
          ledgerEntry = WalletLedgerEntry.create({
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: LedgerDirection.Debit,
            money: transaction.money,
            balanceBefore: walletEntityBalance(walletEntity),
            balanceAfter: resultBalance,
            createdAt: processedAt,
          });
        } catch (error) {
          if (!(error instanceof InsufficientWalletBalanceError)) {
            throw error;
          }

          transaction.reject('INSUFFICIENT_FUNDS');
        }

        const transactionEntity = entityManager.create(WagerTransactionEntity, {
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
          failureCode: transaction.failureCode,
          resultingBalance: resultBalance.toString(),
          createdAt: transaction.createdAt,
          processedAt: transaction.processedAt,
        });
        entityManager.persist(transactionEntity);
        await entityManager.flush();

        if (ledgerEntry) {
          await entityManager.nativeUpdate(
            WalletEntity,
            { id: wallet.id },
            {
              balance: wallet.balance.toString(),
              version: wallet.version,
              updatedAt: wallet.updatedAt,
            },
          );

          entityManager.persist(
            entityManager.create(WalletLedgerEntryEntity, {
              id: ledgerEntry.id,
              walletId: ledgerEntry.walletId,
              transactionId: ledgerEntry.transactionId,
              direction: ledgerEntry.direction,
              amount: ledgerEntry.money.toString(),
              currency: ledgerEntry.money.currency,
              balanceBefore: ledgerEntry.balanceBefore.toString(),
              balanceAfter: ledgerEntry.balanceAfter.toString(),
              createdAt: ledgerEntry.createdAt,
            }),
          );
          await entityManager.flush();
        }

        return { transaction, balance: resultBalance, idempotentReplay: false };
      });
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

      return this.replay(existing, transaction);
    }
  }

  private replay(
    existing: WagerTransactionEntity,
    request: WagerTransaction,
  ): ProcessWagerTransactionResult {
    if (existing.idempotencyKey !== request.idempotencyKey) {
      throw new WagerTransactionAlreadyExistsError();
    }

    const transaction =
      MikroOrmWagerTransactionsRepository.toDomain(existing);
    if (!transaction.matchesPayload(request.payloadHash)) {
      throw new IdempotencyConflictError();
    }

    if (!existing.resultingBalance) {
      throw new DomainError(
        'The original transaction result is not available for replay',
      );
    }

    return {
      transaction,
      balance: Money.from({
        amount: existing.resultingBalance,
        currency: existing.currency,
      }),
      idempotentReplay: true,
    };
  }
}

function walletEntityBalance(wallet: WalletEntity): Money {
  return Money.from({ amount: wallet.balance, currency: wallet.currency });
}
