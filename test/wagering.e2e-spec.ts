import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Money } from '../src/core/domain/money.js';
import { IdempotencyConflictError } from '../src/domain/wagering/application/errors/idempotency-conflict-error.js';
import type {
  ProcessWagerTransactionResult,
  ProcessWagerTransactionsRepository,
} from '../src/domain/wagering/application/repositories/process-wager-transactions-repository.js';
import { ProcessWagerTransactionUseCase } from '../src/domain/wagering/application/use-cases/process-wager-transaction.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../src/domain/wagering/enterprise/entities/wager-transaction.js';
import { HttpExceptionFilter } from '../src/infra/http/filters/http-exception.filter.js';
import { WageringTransactionsController } from '../src/infra/http/controllers/wagering-transactions.controller.js';

class InMemoryProcessWagerTransactionsRepository
  implements ProcessWagerTransactionsRepository
{
  private readonly transactions = new Map<
    string,
    ProcessWagerTransactionResult
  >();

  async process(
    transaction: WagerTransaction,
  ): Promise<ProcessWagerTransactionResult> {
    const key = `${transaction.providerId}:${transaction.idempotencyKey}`;
    const existing = this.transactions.get(key);

    if (existing) {
      if (!existing.transaction.matchesPayload(transaction.payloadHash)) {
        throw new IdempotencyConflictError();
      }

      return { ...existing, idempotentReplay: true };
    }

    if (
      transaction.kind === WagerTransactionKind.Win &&
      transaction.referenceExternalTransactionId
    ) {
      transaction.markPendingReference();
      const result = {
        transaction,
        balance: Money.from({ amount: '975.00', currency: 'BRL' }),
        idempotentReplay: false,
      };
      this.transactions.set(key, result);

      return result;
    }

    if (transaction.kind === WagerTransactionKind.Rollback) {
      const reference = [...this.transactions.values()].find(
        ({ transaction: existing }) =>
          existing.providerId === transaction.providerId &&
          existing.externalTransactionId ===
            transaction.referenceExternalTransactionId,
      )?.transaction;
      const alreadyRolledBack = [...this.transactions.values()].some(
        ({ transaction: existing }) =>
          existing.kind === WagerTransactionKind.Rollback &&
          existing.referenceExternalTransactionId ===
            transaction.referenceExternalTransactionId &&
          existing.status === 'PROCESSED',
      );

      if (!reference) {
        transaction.markPendingReference();
      } else if (
        reference.status !== 'PROCESSED' ||
        (reference.kind !== WagerTransactionKind.Bet &&
          reference.kind !== WagerTransactionKind.Win &&
          reference.kind !== WagerTransactionKind.Refund) ||
        reference.walletId !== transaction.walletId ||
        reference.playerId !== transaction.playerId ||
        reference.roundId !== transaction.roundId
      ) {
        transaction.reject('INVALID_REFERENCE');
      } else if (!reference.money.equals(transaction.money)) {
        transaction.reject('ROLLBACK_AMOUNT_MISMATCH');
      } else if (alreadyRolledBack) {
        transaction.reject('REFERENCE_ALREADY_ROLLED_BACK');
      } else {
        transaction.markProcessed(reference.id, new Date());
      }

      const result = {
        transaction,
        balance: Money.from({ amount: '1000.00', currency: 'BRL' }),
        idempotentReplay: false,
      };
      this.transactions.set(key, result);

      return result;
    }

    if (transaction.kind === WagerTransactionKind.Refund) {
      const reference = [...this.transactions.values()].find(
        ({ transaction: existing }) =>
          existing.providerId === transaction.providerId &&
          existing.externalTransactionId ===
            transaction.referenceExternalTransactionId,
      )?.transaction;
      if (!reference) {
        transaction.markPendingReference();
        const result = {
          transaction,
          balance: Money.from({ amount: '975.00', currency: 'BRL' }),
          idempotentReplay: false,
        };
        this.transactions.set(key, result);

        return result;
      }

      const alreadyRefunded = [...this.transactions.values()].some(
        ({ transaction: existing }) =>
          existing.kind === WagerTransactionKind.Refund &&
          existing.referenceExternalTransactionId ===
            transaction.referenceExternalTransactionId &&
          existing.status === 'PROCESSED',
      );
      if (
        reference.kind !== WagerTransactionKind.Bet ||
        reference.status !== 'PROCESSED' ||
        reference.walletId !== transaction.walletId ||
        reference.playerId !== transaction.playerId ||
        reference.roundId !== transaction.roundId
      ) {
        transaction.reject('INVALID_REFERENCE');
      } else if (!reference.money.equals(transaction.money)) {
        transaction.reject('REFUND_AMOUNT_MISMATCH');
      } else if (alreadyRefunded) {
        transaction.reject('REFERENCE_ALREADY_REFUNDED');
      } else {
        transaction.markProcessed(reference.id, new Date());
      }

      const result = {
        transaction,
        balance: Money.from({
          amount:
            transaction.status === 'PROCESSED' ? '1000.00' : '975.00',
          currency: 'BRL',
        }),
        idempotentReplay: false,
      };
      this.transactions.set(key, result);

      return result;
    }

    if (
      transaction.kind === WagerTransactionKind.Bet &&
      transaction.money.toString() === '50.00'
    ) {
      transaction.reject('INSUFFICIENT_FUNDS');
      const result = {
        transaction,
        balance: Money.from({ amount: '10.00', currency: 'BRL' }),
        idempotentReplay: false,
      };
      this.transactions.set(key, result);

      return result;
    }

    transaction.markProcessed(undefined, new Date());
    const result = {
      transaction,
      balance:
        transaction.kind === WagerTransactionKind.Bet
          ? Money.from({ amount: '975.00', currency: 'BRL' })
          : transaction.kind === WagerTransactionKind.Loss
            ? Money.from({ amount: '1000.00', currency: 'BRL' })
            : Money.from({ amount: '1025.00', currency: 'BRL' }),
      idempotentReplay: false,
    };
    this.transactions.set(key, result);

    return result;
  }
}

describe('Wagering transactions HTTP (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const repository = new InMemoryProcessWagerTransactionsRepository();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [WageringTransactionsController],
      providers: [
        {
          provide: ProcessWagerTransactionUseCase,
          useFactory: () => new ProcessWagerTransactionUseCase(repository),
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a BET and returns the resulting balance', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:transaction-123')
      .send(body)
      .expect(200);

    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:transaction-123')
      .send(body)
      .expect(200)
      .expect(({ body: replay }) => {
        expect(replay.transactionId).toBe(first.body.transactionId);
        expect(replay.balance).toEqual(first.body.balance);
        expect(replay.idempotentReplay).toBe(true);
      });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:transaction-123')
      .send({ ...body, money: { amount: '26.00', currency: 'BRL' } })
      .expect(409);
  });

  it('requires an idempotency key and rejects unsupported transaction kinds', async () => {
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: randomUUID(),
      walletId: randomUUID(),
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send(body)
      .expect(400);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:transaction-123')
      .send({ ...body, kind: 'ROLLBACK' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-without-reference')
      .send({ ...body, kind: 'REFUND' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:rollback-without-reference')
      .send({ ...body, kind: 'ROLLBACK' })
      .expect(400);
  });

  it('processes WIN and LOSS and leaves referenced WIN pending when its BET is absent', async () => {
    const common = {
      providerId: 'provider-a',
      playerId: randomUUID(),
      walletId: randomUUID(),
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      money: { amount: '25.00', currency: 'BRL' },
    };

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:win-1')
      .send({
        ...common,
        externalTransactionId: 'win-1',
        kind: 'WIN',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'PROCESSED',
          balance: { amount: '1025.00', currency: 'BRL' },
          idempotentReplay: false,
        });
      });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:loss-1')
      .send({
        ...common,
        externalTransactionId: 'loss-1',
        kind: 'LOSS',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'PROCESSED',
          balance: { amount: '1000.00', currency: 'BRL' },
        });
      });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:win-pending')
      .send({
        ...common,
        externalTransactionId: 'win-pending',
        kind: 'WIN',
        referenceExternalTransactionId: 'bet-not-yet-received',
      })
      .expect(202)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'PENDING_REFERENCE',
          balance: { amount: '975.00', currency: 'BRL' },
          idempotentReplay: false,
        });
      });
  });

  it('accepts REFUND and records a response for its BET reference', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const bet = {
      providerId: 'provider-a',
      externalTransactionId: 'refund-bet-123',
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-bet-123')
      .send(bet)
      .expect(200);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-123')
      .send({
        ...bet,
        externalTransactionId: 'refund-123',
        kind: 'REFUND',
        referenceExternalTransactionId: 'refund-bet-123',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'PROCESSED',
          balance: { amount: '1000.00', currency: 'BRL' },
          idempotentReplay: false,
        });
      });
  });

  it('returns pending and rejection responses for unresolved or invalid REFUNDs', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const common = {
      providerId: 'provider-a',
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      money: { amount: '25.00', currency: 'BRL' },
    };

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-pending-http')
      .send({
        ...common,
        externalTransactionId: 'refund-pending-http',
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-not-yet-received',
      })
      .expect(202)
      .expect(({ body }) => {
        expect(body.status).toBe('PENDING_REFERENCE');
      });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-bet-http')
      .send({
        ...common,
        externalTransactionId: 'refund-bet-http',
        kind: 'BET',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-mismatch-http')
      .send({
        ...common,
        externalTransactionId: 'refund-mismatch-http',
        kind: 'REFUND',
        referenceExternalTransactionId: 'refund-bet-http',
        money: { amount: '24.99', currency: 'BRL' },
      })
      .expect(422)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'REJECTED',
          failureCode: 'REFUND_AMOUNT_MISMATCH',
        });
      });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-valid-http')
      .send({
        ...common,
        externalTransactionId: 'refund-valid-http',
        kind: 'REFUND',
        referenceExternalTransactionId: 'refund-bet-http',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:refund-duplicate-http')
      .send({
        ...common,
        externalTransactionId: 'refund-duplicate-http',
        kind: 'REFUND',
        referenceExternalTransactionId: 'refund-bet-http',
      })
      .expect(422)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'REJECTED',
          failureCode: 'REFERENCE_ALREADY_REFUNDED',
        });
      });
  });

  it('accepts ROLLBACK and rejects a second rollback of the same reference', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const bet = {
      providerId: 'provider-a',
      externalTransactionId: 'rollback-bet-http',
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:rollback-bet-http')
      .send(bet)
      .expect(200);

    const rollback = {
      ...bet,
      externalTransactionId: 'rollback-http',
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'rollback-bet-http',
    };

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:rollback-http')
      .send(rollback)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'PROCESSED',
          idempotentReplay: false,
        });
      });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:rollback-http-duplicate')
      .send({
        ...rollback,
        externalTransactionId: 'rollback-http-duplicate',
      })
      .expect(422)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'REJECTED',
          failureCode: 'REFERENCE_ALREADY_ROLLED_BACK',
        });
      });
  });

  it('returns an explicit business rejection for insufficient funds', async () => {
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:insufficient-bet')
      .send({
        providerId: 'provider-a',
        externalTransactionId: 'insufficient-bet',
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      })
      .expect(422)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'REJECTED',
          balance: { amount: '10.00', currency: 'BRL' },
          failureCode: 'INSUFFICIENT_FUNDS',
          idempotentReplay: false,
        });
      });
  });
});
