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
import { ProcessBetUseCase } from '../src/domain/wagering/application/use-cases/process-bet.js';
import { WagerTransaction } from '../src/domain/wagering/enterprise/entities/wager-transaction.js';
import { HttpExceptionFilter } from '../src/infra/http/filters/http-exception.filter.js';
import { WageringTransactionsController } from '../src/infra/http/controllers/wagering-transactions.controller.js';

class InMemoryProcessWagerTransactionsRepository
  implements ProcessWagerTransactionsRepository
{
  private readonly transactions = new Map<
    string,
    ProcessWagerTransactionResult
  >();

  async processBet(
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

    if (transaction.money.toString() === '50.00') {
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
      balance: Money.from({ amount: '975.00', currency: 'BRL' }),
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
          provide: ProcessBetUseCase,
          useFactory: () => new ProcessBetUseCase(repository),
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

  it('requires an idempotency key and accepts only valid BET payloads', async () => {
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
      .send({ ...body, kind: 'WIN' })
      .expect(400);
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
