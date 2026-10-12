import { randomUUID } from 'node:crypto';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
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
  WagerTransactionStatus,
} from '../../../../domain/wagering/enterprise/entities/wager-transaction.js';
import { InsufficientWalletBalanceError } from '../../../../domain/wallets/enterprise/errors/insufficient-wallet-balance-error.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../../domain/wallets/enterprise/entities/wallet-ledger-entry.js';
import { Wallet } from '../../../../domain/wallets/enterprise/entities/wallet.js';
import { WalletNotFoundError } from '../../../../domain/wallets/application/errors/wallet-not-found-error.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { MikroOrmWagerTransactionsRepository } from './mikro-orm-wager-transactions.repository.js';

export class MikroOrmProcessWagerTransactionsRepository implements ProcessWagerTransactionsRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async process(
    transaction: WagerTransaction,
  ): Promise<ProcessWagerTransactionResult> {
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
        const balanceBefore = wallet.balance;
        let referenceTransactionId: string | undefined;
        let rejected = false;
        const processedReference =
          (transaction.kind === WagerTransactionKind.Win ||
            transaction.kind === WagerTransactionKind.Refund ||
            transaction.kind === WagerTransactionKind.Rollback) &&
          transaction.referenceExternalTransactionId
            ? await entityManager.findOne(WagerTransactionEntity, {
                providerId: transaction.providerId,
                externalTransactionId:
                  transaction.referenceExternalTransactionId,
              })
            : null;

        if (
          transaction.kind === WagerTransactionKind.Win &&
          transaction.referenceExternalTransactionId
        ) {
          if (
            !processedReference ||
            processedReference.status === WagerTransactionStatus.Pending ||
            processedReference.status ===
              WagerTransactionStatus.PendingReference
          ) {
            transaction.markPendingReference();
          } else if (
            processedReference.status !== WagerTransactionStatus.Processed
          ) {
            transaction.reject('INVALID_REFERENCE');
          } else if (
            processedReference.kind !== WagerTransactionKind.Bet ||
            processedReference.walletId !== transaction.walletId ||
            processedReference.playerId !== transaction.playerId ||
            processedReference.roundId !== transaction.roundId ||
            processedReference.currency !== transaction.money.currency
          ) {
            transaction.reject('INVALID_REFERENCE');
          } else {
            referenceTransactionId = processedReference.id;
          }
        }

        if (
          transaction.kind === WagerTransactionKind.Refund &&
          transaction.referenceExternalTransactionId
        ) {
          if (
            !processedReference ||
            processedReference.status === WagerTransactionStatus.Pending ||
            processedReference.status ===
              WagerTransactionStatus.PendingReference
          ) {
            transaction.markPendingReference();
          } else if (
            processedReference.status !== WagerTransactionStatus.Processed ||
            processedReference.kind !== WagerTransactionKind.Bet ||
            processedReference.walletId !== transaction.walletId ||
            processedReference.playerId !== transaction.playerId ||
            processedReference.providerId !== transaction.providerId ||
            processedReference.roundId !== transaction.roundId ||
            processedReference.currency !== transaction.money.currency
          ) {
            transaction.reject('INVALID_REFERENCE');
            rejected = true;
          } else if (
            !Money.from({
              amount: processedReference.amount,
              currency: processedReference.currency,
            }).equals(transaction.money)
          ) {
            transaction.reject('REFUND_AMOUNT_MISMATCH');
            rejected = true;
          } else {
            const existingRefund = await entityManager.findOne(
              WagerTransactionEntity,
              {
                kind: WagerTransactionKind.Refund,
                referenceTransactionId: processedReference.id,
              },
            );
            if (existingRefund) {
              transaction.reject('REFERENCE_ALREADY_REFUNDED');
              rejected = true;
            } else {
              referenceTransactionId = processedReference.id;
            }
          }
        }

        if (
          transaction.kind === WagerTransactionKind.Rollback &&
          transaction.referenceExternalTransactionId
        ) {
          if (
            !processedReference ||
            processedReference.status === WagerTransactionStatus.Pending ||
            processedReference.status ===
              WagerTransactionStatus.PendingReference
          ) {
            transaction.markPendingReference();
          } else if (
            processedReference.status !== WagerTransactionStatus.Processed ||
            (processedReference.kind !== WagerTransactionKind.Bet &&
              processedReference.kind !== WagerTransactionKind.Win &&
              processedReference.kind !== WagerTransactionKind.Refund) ||
            processedReference.walletId !== transaction.walletId ||
            processedReference.playerId !== transaction.playerId ||
            processedReference.providerId !== transaction.providerId ||
            processedReference.roundId !== transaction.roundId ||
            processedReference.currency !== transaction.money.currency
          ) {
            transaction.reject('INVALID_REFERENCE');
            rejected = true;
          } else if (
            !Money.from({
              amount: processedReference.amount,
              currency: processedReference.currency,
            }).equals(transaction.money)
          ) {
            transaction.reject('ROLLBACK_AMOUNT_MISMATCH');
            rejected = true;
          } else {
            const existingRollback = await entityManager.findOne(
              WagerTransactionEntity,
              {
                kind: WagerTransactionKind.Rollback,
                referenceTransactionId: processedReference.id,
                status: WagerTransactionStatus.Processed,
              },
            );
            if (existingRollback) {
              transaction.reject('REFERENCE_ALREADY_ROLLED_BACK');
              rejected = true;
            } else {
              referenceTransactionId = processedReference.id;
            }
          }
        }

        if (
          transaction.status !== WagerTransactionStatus.PendingReference &&
          transaction.status !== WagerTransactionStatus.Rejected
        ) {
          const processedAt = new Date();
          if (transaction.kind === WagerTransactionKind.Bet) {
            try {
              wallet.debit(transaction.money);
            } catch (error) {
              if (!(error instanceof InsufficientWalletBalanceError)) {
                throw error;
              }

              transaction.reject('INSUFFICIENT_FUNDS');
              rejected = true;
            }
          } else if (
            transaction.kind === WagerTransactionKind.Win ||
            transaction.kind === WagerTransactionKind.Refund
          ) {
            wallet.credit(transaction.money);
          } else if (
            transaction.kind === WagerTransactionKind.Rollback &&
            processedReference?.kind === WagerTransactionKind.Bet
          ) {
            wallet.credit(transaction.money);
          } else if (transaction.kind === WagerTransactionKind.Rollback) {
            try {
              wallet.debit(transaction.money);
            } catch (error) {
              if (!(error instanceof InsufficientWalletBalanceError)) {
                throw error;
              }

              transaction.reject('ROLLBACK_INSUFFICIENT_FUNDS');
              rejected = true;
            }
          }

          if (!rejected) {
            transaction.markProcessed(referenceTransactionId, processedAt);
            if (transaction.kind === WagerTransactionKind.Bet) {
              ledgerEntry = WalletLedgerEntry.create({
                walletId: wallet.id,
                transactionId: transaction.id,
                direction: LedgerDirection.Debit,
                money: transaction.money,
                balanceBefore,
                balanceAfter: wallet.balance,
                createdAt: processedAt,
              });
            } else if (
              transaction.kind === WagerTransactionKind.Win ||
              transaction.kind === WagerTransactionKind.Refund ||
              (transaction.kind === WagerTransactionKind.Rollback &&
                processedReference?.kind === WagerTransactionKind.Bet)
            ) {
              ledgerEntry = WalletLedgerEntry.create({
                walletId: wallet.id,
                transactionId: transaction.id,
                direction: LedgerDirection.Credit,
                money: transaction.money,
                balanceBefore,
                balanceAfter: wallet.balance,
                createdAt: processedAt,
              });
            } else if (transaction.kind === WagerTransactionKind.Rollback) {
              ledgerEntry = WalletLedgerEntry.create({
                walletId: wallet.id,
                transactionId: transaction.id,
                direction: LedgerDirection.Debit,
                money: transaction.money,
                balanceBefore,
                balanceAfter: wallet.balance,
                createdAt: processedAt,
              });
            }
          }
        }

        const resultBalance = wallet.balance;
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
          referenceExternalTransactionId:
            transaction.referenceExternalTransactionId,
          referenceTransactionId,
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

        if (transaction.status === WagerTransactionStatus.Processed) {
          if (!transaction.processedAt) {
            throw new Error(
              'Processed wager transaction is missing its processing timestamp',
            );
          }

          entityManager.persist(
            entityManager.create(OutboxMessageEntity, {
              id: randomUUID(),
              deduplicationKey: `wager-transaction:${transaction.id}:processed`,
              aggregateType: 'wager-transaction',
              aggregateId: transaction.id,
              eventType: 'WagerTransactionProcessed',
              payload: {
                transactionId: transaction.id,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                walletId: transaction.walletId,
                playerId: transaction.playerId,
                roundId: transaction.roundId,
                gameId: transaction.gameId,
                kind: transaction.kind,
                amount: transaction.money.toString(),
                currency: transaction.money.currency,
                referenceTransactionId: referenceTransactionId ?? null,
                resultingBalance: resultBalance.toString(),
                processedAt: transaction.processedAt.toISOString(),
              },
              status: 'PENDING',
              attempts: 0,
              availableAt: transaction.processedAt,
              occurredAt: transaction.processedAt,
            }),
          );
          await entityManager.flush();
        }

        return {
          transaction,
          balance: resultBalance,
          idempotentReplay: false,
        };
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

      if (
        transaction.kind === WagerTransactionKind.Refund &&
        existing.kind === WagerTransactionKind.Refund &&
        existing.referenceExternalTransactionId ===
          transaction.referenceExternalTransactionId
      ) {
        throw new DomainError('The referenced BET has already been refunded');
      }
      if (
        transaction.kind === WagerTransactionKind.Rollback &&
        existing.kind === WagerTransactionKind.Rollback &&
        existing.referenceExternalTransactionId ===
          transaction.referenceExternalTransactionId
      ) {
        throw new DomainError(
          'The referenced transaction has already been rolled back',
        );
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

    const transaction = MikroOrmWagerTransactionsRepository.toDomain(existing);
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
