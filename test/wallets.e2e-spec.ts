import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Money } from '../src/core/domain/money.js';
import type { WalletsRepository } from '../src/domain/wallets/application/repositories/wallets-repository.js';
import type {
  WalletLedgerCursorPosition,
  WalletLedgerEntriesRepository,
  WalletLedgerEntryPageItem,
} from '../src/domain/wallets/application/repositories/wallet-ledger-entries-repository.js';
import type { WalletOpeningLedger } from '../src/domain/wallets/application/repositories/wallets-repository.js';
import { OpenWalletUseCase } from '../src/domain/wallets/application/use-cases/open-wallet.js';
import { GetWalletUseCase } from '../src/domain/wallets/application/use-cases/get-wallet.js';
import { GetWalletLedgerUseCase } from '../src/domain/wallets/application/use-cases/get-wallet-ledger.js';
import { Wallet } from '../src/domain/wallets/enterprise/entities/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../src/domain/wallets/enterprise/entities/wallet-ledger-entry.js';
import { HttpExceptionFilter } from '../src/infra/http/filters/http-exception.filter.js';
import { WalletsController } from '../src/infra/http/controllers/wallets.controller.js';

class InMemoryWalletsRepository implements WalletsRepository {
  private readonly wallets: Wallet[] = [];
  readonly ledgerEntries: WalletLedgerEntry[] = [];

  async create(
    wallet: Wallet,
    openingLedger?: WalletOpeningLedger,
  ): Promise<void> {
    this.wallets.push(wallet);
    if (openingLedger) {
      this.ledgerEntries.push(openingLedger.ledgerEntry);
    }
  }

  async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const wallet = this.wallets.find(
      (candidate) => candidate.playerId === playerId && candidate.currency === currency,
    );

    return wallet ?? null;
  }

  async findById(walletId: string): Promise<Wallet | null> {
    return this.wallets.find((wallet) => wallet.id === walletId) ?? null;
  }
}

class InMemoryWalletLedgerEntriesRepository
  implements WalletLedgerEntriesRepository
{
  constructor(private readonly walletsRepository: InMemoryWalletsRepository) {}

  async findPage(
    walletId: string,
    limit: number,
    before?: WalletLedgerCursorPosition,
  ): Promise<WalletLedgerEntryPageItem[]> {
    return this.walletsRepository.ledgerEntries
      .filter((entry) => entry.walletId === walletId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .filter((entry) => {
        if (!before) {
          return true;
        }

        const timestamp = entry.createdAt
          .toISOString()
          .replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => `.${milliseconds}000Z`);
        return (
          timestamp < before.createdAt ||
          (timestamp === before.createdAt && entry.id < before.id)
        );
      })
      .slice(0, limit)
      .map((entry) => ({
        entry,
        cursorCreatedAt: entry.createdAt
          .toISOString()
          .replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => `.${milliseconds}000Z`),
      }));
  }
}

describe('Wallets HTTP (e2e)', () => {
  let app: INestApplication<App>;
  let walletsRepository: InMemoryWalletsRepository;

  beforeAll(async () => {
    walletsRepository = new InMemoryWalletsRepository();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        {
          provide: OpenWalletUseCase,
          useFactory: () => new OpenWalletUseCase(walletsRepository),
        },
        {
          provide: GetWalletUseCase,
          useFactory: () => new GetWalletUseCase(walletsRepository),
        },
        {
          provide: GetWalletLedgerUseCase,
          useFactory: () =>
            new GetWalletLedgerUseCase(
              walletsRepository,
              new InMemoryWalletLedgerEntriesRepository(walletsRepository),
            ),
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

  it('gets a wallet by UUID', async () => {
    const playerId = randomUUID();
    const { wallet } = await new OpenWalletUseCase(walletsRepository).execute({
      playerId,
      initialBalance: Money.from({ amount: '42.75', currency: 'BRL' }),
    });

    await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: wallet.id,
          playerId,
          balance: { amount: '42.75', currency: 'BRL' },
          version: 1,
        });
      });
  });

  it('returns 404 when the wallet does not exist', async () => {
    await request(app.getHttpServer()).get(`/wallets/${randomUUID()}`).expect(404);
  });

  it('rejects an invalid wallet UUID', async () => {
    await request(app.getHttpServer()).get('/wallets/not-a-uuid').expect(400);
  });

  it('returns a wallet ledger page with an opaque cursor', async () => {
    const { wallet } = await new OpenWalletUseCase(walletsRepository).execute({
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '42.75', currency: 'BRL' }),
    });
    const additionalCredit = Money.from({ amount: '1.00', currency: 'BRL' });
    walletsRepository.ledgerEntries.push(
      WalletLedgerEntry.create({
        walletId: wallet.id,
        transactionId: randomUUID(),
        direction: LedgerDirection.Credit,
        money: additionalCredit,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance.add(additionalCredit),
        createdAt: new Date(wallet.createdAt.getTime() + 1_000),
      }),
    );

    const firstPage = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?limit=1`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0]).toMatchObject({
          walletId: wallet.id,
          direction: 'CREDIT',
          amount: { amount: '1.00', currency: 'BRL' },
        });
        expect(body.nextCursor).toEqual(expect.any(String));
      });

    await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?limit=1&cursor=${firstPage.body.nextCursor}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].amount).toEqual({
          amount: '42.75',
          currency: 'BRL',
        });
        expect(body.nextCursor).toBeNull();
      });
  });

  it('rejects malformed ledger cursors and invalid page sizes', async () => {
    const walletId = randomUUID();

    await request(app.getHttpServer())
      .get(`/wallets/${walletId}/ledger?cursor=not-a-cursor`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/wallets/${walletId}/ledger?limit=101`)
      .expect(400);
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
