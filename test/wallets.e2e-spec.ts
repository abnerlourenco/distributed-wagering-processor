import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { WalletsRepository } from '../src/domain/wallets/application/repositories/wallets-repository.js';
import { OpenWalletUseCase } from '../src/domain/wallets/application/use-cases/open-wallet.js';
import { Wallet } from '../src/domain/wallets/enterprise/entities/wallet.js';
import { HttpExceptionFilter } from '../src/infra/http/filters/http-exception.filter.js';
import { WalletsController } from '../src/infra/http/controllers/wallets.controller.js';

class InMemoryWalletsRepository implements WalletsRepository {
  private readonly wallets: Wallet[] = [];

  async create(wallet: Wallet): Promise<void> {
    this.wallets.push(wallet);
  }

  async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const wallet = this.wallets.find(
      (candidate) => candidate.playerId === playerId && candidate.currency === currency,
    );

    return wallet ?? null;
  }
}

describe('Wallets HTTP (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        {
          provide: OpenWalletUseCase,
          useFactory: () => new OpenWalletUseCase(new InMemoryWalletsRepository()),
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

  it('creates a wallet with an exact initial balance', async () => {
    const playerId = randomUUID();

    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '123.45', currency: 'BRL' },
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          playerId,
          balance: { amount: '123.45', currency: 'BRL' },
          version: 1,
        });
        expect(body.id).toEqual(expect.any(String));
      });
  });

  it('creates a zero-balance wallet', async () => {
    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: '0.00', currency: 'BRL' },
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      });
  });

  it('rejects invalid monetary input', async () => {
    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: '123.456', currency: 'BRL' },
      })
      .expect(400);
  });

  it('returns a conflict when the player already has a wallet in that currency', async () => {
    const playerId = randomUUID();
    const body = {
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    };

    await request(app.getHttpServer()).post('/wallets').send(body).expect(201);
    await request(app.getHttpServer())
      .post('/wallets')
      .send({ ...body, initialBalance: { amount: '0.00', currency: 'BRL' } })
      .expect(409);
  });
});
