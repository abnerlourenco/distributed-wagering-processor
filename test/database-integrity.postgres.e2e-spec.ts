import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../src/core/domain/money.js';
import { OpenWalletUseCase } from '../src/domain/wallets/application/use-cases/open-wallet.js';
import { ReconcileWalletUseCase } from '../src/domain/wallets/application/use-cases/reconcile-wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../src/domain/wallets/enterprise/entities/wallet-ledger-entry.js';
import { Wallet } from '../src/domain/wallets/enterprise/entities/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../src/domain/wagering/enterprise/entities/wager-transaction.js';
import { mikroOrmConfig } from '../src/infra/database/mikro-orm.config.js';
import { MikroOrmWalletLedgerEntriesRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-wallet-ledger-entries.repository.js';
import { MikroOrmProcessWagerTransactionsRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-process-wager-transactions.repository.js';
import { MikroOrmWagerTransactionsRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-wager-transactions.repository.js';
import { MikroOrmWalletsRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-wallets.repository.js';
import { MikroOrmWalletReconciliationRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-wallet-reconciliation.repository.js';
import { ProcessBetUseCase } from '../src/domain/wagering/application/use-cases/process-bet.js';
import { ProcessWagerTransactionUseCase } from '../src/domain/wagering/application/use-cases/process-wager-transaction.js';
import { IdempotencyConflictError } from '../src/domain/wagering/application/errors/idempotency-conflict-error.js';

const testDatabaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const testDatabaseName = testDatabaseUrl
  ? new URL(testDatabaseUrl).pathname.slice(1)
  : '';

if (!testDatabaseUrl || !/(^|[-_])test$/i.test(testDatabaseName)) {
  throw new Error(
    'POSTGRES_TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test or -test',
  );
}

describe('PostgreSQL migrations and integrity constraints', () => {
  let orm: MikroORM;

  async function execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<unknown> {
    return orm.em.getConnection().execute(sql, params);
  }

  async function insertWallet(
    props: {
      id?: string;
      playerId?: string;
      currency?: string;
      balance?: string;
    } = {},
  ): Promise<{ id: string; playerId: string }> {
    const id = props.id ?? randomUUID();
    const playerId = props.playerId ?? randomUUID();

    await execute(
      'insert into "wallets" ("id", "player_id", "currency", "balance", "version") values (?, ?, ?, ?, 1)',
      [id, playerId, props.currency ?? 'BRL', props.balance ?? '100.00'],
    );

    return { id, playerId };
  }

  async function insertWagerTransaction(props: {
    id?: string;
    walletId: string;
    playerId: string;
    externalTransactionId?: string;
    idempotencyKey?: string;
  }): Promise<string> {
    const id = props.id ?? randomUUID();

    await execute(
      `insert into "wager_transactions" (
        "id", "provider_id", "external_transaction_id", "idempotency_key",
        "payload_hash", "wallet_id", "player_id", "round_id", "game_id",
        "kind", "amount", "currency", "status"
      ) values (?, 'integration-provider', ?, ?, 'payload-hash', ?, ?, 'round-1', 'game-1', 'BET', 25.00, 'BRL', 'PENDING')`,
      [
        id,
        props.externalTransactionId ?? randomUUID(),
        props.idempotencyKey ?? randomUUID(),
        props.walletId,
        props.playerId,
      ],
    );

    return id;
  }

  beforeAll(async () => {
    orm = await MikroORM.init({
      ...mikroOrmConfig,
      clientUrl: testDatabaseUrl,
    });
    await orm.migrator.up();
  });

  beforeEach(async () => {
    await execute(
      'truncate table "outbox_messages", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" cascade',
    );
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('applies migrations and creates the tables and critical constraints', async () => {
    const tables = (await execute(`
      select tablename
      from pg_tables
      where schemaname = current_schema()
        and tablename in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages')
      order by tablename
    `)) as Array<{ tablename: string }>;

    expect(tables.map(({ tablename }) => tablename)).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    const constraints = (await execute(`
      select conname
      from pg_constraint
      where conname in (
        'wallets_balance_non_negative',
        'wager_transactions_provider_idempotency_key_unique',
        'wager_transactions_resulting_balance_non_negative',
        'wallet_ledger_entries_balance_consistent',
        'inbox_messages_consumer_source_message_unique',
        'outbox_messages_deduplication_key_unique'
      )
    `)) as Array<{ conname: string }>;

    expect(constraints.map(({ conname }) => conname).sort()).toEqual([
      'inbox_messages_consumer_source_message_unique',
      'outbox_messages_deduplication_key_unique',
      'wager_transactions_provider_idempotency_key_unique',
      'wager_transactions_resulting_balance_non_negative',
      'wallet_ledger_entries_balance_consistent',
      'wallets_balance_non_negative',
    ]);
  });

  it('enforces non-negative balances and unique player/currency wallets', async () => {
    const wallet = await insertWallet();

    await expect(
      execute(
        'insert into "wallets" ("id", "player_id", "currency", "balance", "version") values (?, ?, ?, ?, 1)',
        [randomUUID(), randomUUID(), 'BRL', '-0.01'],
      ),
    ).rejects.toThrow();

    await expect(insertWallet({ playerId: wallet.playerId })).rejects.toThrow();
  });

  it('loads a persisted wallet by ID with exact balance and version', async () => {
    const persisted = await insertWallet({ balance: '125.40' });
    const repository = new MikroOrmWalletsRepository(orm.em.fork({ clear: true }));

    const wallet = await repository.findById(persisted.id);

    expect(wallet).not.toBeNull();
    expect(wallet?.id).toBe(persisted.id);
    expect(wallet?.playerId).toBe(persisted.playerId);
    expect(wallet?.balance.toJSON()).toEqual({ amount: '125.40', currency: 'BRL' });
    expect(wallet?.version).toBe(1);
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('paginates the ledger with a stable keyset cursor at microsecond precision', async () => {
    const wallet = await insertWallet();
    const ledgerIds = [randomUUID(), randomUUID(), randomUUID()];
    const createdAt = [
      '2026-01-01T00:00:00.000001Z',
      '2026-01-01T00:00:00.000002Z',
      '2026-01-01T00:00:00.000003Z',
    ];

    for (let index = 0; index < ledgerIds.length; index += 1) {
      const transactionId = await insertWagerTransaction({
        walletId: wallet.id,
        playerId: wallet.playerId,
      });
      await execute(
        `insert into "wallet_ledger_entries" (
          "id", "wallet_id", "transaction_id", "direction", "amount",
          "currency", "balance_before", "balance_after", "created_at"
        ) values (?, ?, ?, 'CREDIT', 1.00, 'BRL', ?, ?, ?::timestamptz)`,
        [
          ledgerIds[index],
          wallet.id,
          transactionId,
          (100 + index).toFixed(2),
          (101 + index).toFixed(2),
          createdAt[index],
        ],
      );
    }

    const repository = new MikroOrmWalletLedgerEntriesRepository(
      orm.em.fork({ clear: true }),
    );
    const firstPage = await repository.findPage(wallet.id, 3);

    expect(firstPage.map(({ entry }) => entry.id)).toEqual([
      ledgerIds[2],
      ledgerIds[1],
      ledgerIds[0],
    ]);
    expect(firstPage[0].cursorCreatedAt).toBe(
      '2026-01-01T00:00:00.000003Z',
    );

    const secondPage = await repository.findPage(wallet.id, 2, {
      createdAt: firstPage[1].cursorCreatedAt,
      id: firstPage[1].entry.id,
    });

    expect(secondPage.map(({ entry }) => entry.id)).toEqual([ledgerIds[0]]);
  });

  it('processes a BET with the wallet, transaction, and ledger updated atomically', async () => {
    const wallet = await insertWallet({ balance: '100.00' });
    const result = await new ProcessBetUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    ).execute({
      providerId: 'provider-a',
      externalTransactionId: 'bet-transaction-1',
      idempotencyKey: 'provider-a:bet-transaction-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(result.transaction.status).toBe('PROCESSED');
    expect(result.balance.toString()).toBe('75.00');
    expect(result.idempotentReplay).toBe(false);
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '75.00', version: 2 }]);
    expect(
      await execute(
        `select "status", "resulting_balance", "failure_code"
         from "wager_transactions" where "id" = ?`,
        [result.transaction.id],
      ),
    ).toEqual([
      {
        status: 'PROCESSED',
        resulting_balance: '75.00',
        failure_code: null,
      },
    ]);
    expect(
      await execute(
        `select "direction", "amount", "balance_before", "balance_after"
         from "wallet_ledger_entries" where "transaction_id" = ?`,
        [result.transaction.id],
      ),
    ).toEqual([
      {
        direction: 'DEBIT',
        amount: '25.00',
        balance_before: '100.00',
        balance_after: '75.00',
      },
    ]);
  });

  it('credits WIN atomically when its referenced BET has already been processed', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const repository = new MikroOrmProcessWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );
    const bet = await new ProcessBetUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'win-reference-bet',
      idempotencyKey: 'provider-a:win-reference-bet',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const win = await new ProcessWagerTransactionUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'win-reference-win',
      idempotencyKey: 'provider-a:win-reference-win',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'win-reference-bet',
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(win.transaction.status).toBe('PROCESSED');
    expect(win.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(win.balance.toString()).toBe('100.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '100.00', version: 3 }]);
    expect(
      await execute(
        `select "direction", "amount", "balance_before", "balance_after"
         from "wallet_ledger_entries" where "transaction_id" = ?`,
        [win.transaction.id],
      ),
    ).toEqual([
      {
        direction: 'CREDIT',
        amount: '50.00',
        balance_before: '50.00',
        balance_after: '100.00',
      },
    ]);
  });

  it('processes LOSS without changing the wallet or creating a ledger entry', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const result = await new ProcessWagerTransactionUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    ).execute({
      providerId: 'provider-a',
      externalTransactionId: 'loss-no-balance',
      idempotencyKey: 'provider-a:loss-no-balance',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(result.transaction.status).toBe('PROCESSED');
    expect(result.balance.toString()).toBe('75.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '75.00', version: 1 }]);
    expect(
      await execute(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('stores a WIN with a missing BET reference as pending without crediting the wallet', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const result = await new ProcessWagerTransactionUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    ).execute({
      providerId: 'provider-a',
      externalTransactionId: 'win-pending-reference',
      idempotencyKey: 'provider-a:win-pending-reference',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'missing-bet',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(result.transaction.status).toBe('PENDING_REFERENCE');
    expect(result.balance.toString()).toBe('75.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '75.00', version: 1 }]);
    expect(
      await execute(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('rejects a WIN referencing a BET from a different round without crediting', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const repository = new MikroOrmProcessWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );
    await new ProcessBetUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'invalid-win-reference-bet',
      idempotencyKey: 'provider-a:invalid-win-reference-bet',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const result = await new ProcessWagerTransactionUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'invalid-win-reference',
      idempotencyKey: 'provider-a:invalid-win-reference',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'invalid-win-reference-bet',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(result.transaction.status).toBe('REJECTED');
    expect(result.transaction.failureCode).toBe('INVALID_REFERENCE');
    expect(result.balance.toString()).toBe('50.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '50.00', version: 2 }]);
    expect(
      await execute(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('refunds a processed BET exactly once and credits the amount atomically', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const repository = new MikroOrmProcessWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );
    const bet = await new ProcessBetUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'refund-reference-bet',
      idempotencyKey: 'provider-a:refund-reference-bet',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const refundRequest = {
      providerId: 'provider-a',
      externalTransactionId: 'refund-reference-refund',
      idempotencyKey: 'provider-a:refund-reference-refund',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'refund-reference-bet',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    };
    const refund = await new ProcessWagerTransactionUseCase(repository).execute(
      refundRequest,
    );

    expect(refund.transaction.status).toBe('PROCESSED');
    expect(refund.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(refund.balance.toString()).toBe('75.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '75.00', version: 3 }]);
    expect(
      await execute(
        `select "direction", "amount", "balance_before", "balance_after"
         from "wallet_ledger_entries" where "transaction_id" = ?`,
        [refund.transaction.id],
      ),
    ).toEqual([
      {
        direction: 'CREDIT',
        amount: '25.00',
        balance_before: '50.00',
        balance_after: '75.00',
      },
    ]);

    const secondRefund = await new ProcessWagerTransactionUseCase(
      repository,
    ).execute({
      ...refundRequest,
      externalTransactionId: 'refund-reference-refund-2',
      idempotencyKey: 'provider-a:refund-reference-refund-2',
    });
    expect(secondRefund.transaction.status).toBe('REJECTED');
    expect(secondRefund.transaction.failureCode).toBe(
      'REFERENCE_ALREADY_REFUNDED',
    );
    expect(secondRefund.balance.toString()).toBe('75.00');
    expect(
      await execute(
        `select count(*)::int as "count"
         from "wager_transactions"
         where "kind" = 'REFUND'
           and "reference_transaction_id" = ?`,
        [bet.transaction.id],
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await execute(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "transaction_id" = ?',
        [secondRefund.transaction.id],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('rejects a REFUND with a mismatched amount without changing the wallet', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const repository = new MikroOrmProcessWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );
    await new ProcessBetUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'refund-amount-bet',
      idempotencyKey: 'provider-a:refund-amount-bet',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const refund = await new ProcessWagerTransactionUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'refund-amount-mismatch',
      idempotencyKey: 'provider-a:refund-amount-mismatch',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'refund-amount-bet',
      money: Money.from({ amount: '24.99', currency: 'BRL' }),
    });

    expect(refund.transaction.status).toBe('REJECTED');
    expect(refund.transaction.failureCode).toBe('REFUND_AMOUNT_MISMATCH');
    expect(refund.balance.toString()).toBe('50.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '50.00', version: 2 }]);
  });

  it('stores REFUND with an absent BET reference as pending without crediting', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const result = await new ProcessWagerTransactionUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    ).execute({
      providerId: 'provider-a',
      externalTransactionId: 'refund-pending-reference',
      idempotencyKey: 'provider-a:refund-pending-reference',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'missing-refund-bet',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(result.transaction.status).toBe('PENDING_REFERENCE');
    expect(result.balance.toString()).toBe('75.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '75.00', version: 1 }]);
    expect(
      await execute(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('rolls back a processed BET exactly once under concurrent requests', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const repository = new MikroOrmProcessWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );
    const bet = await new ProcessBetUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-bet-reference',
      idempotencyKey: 'provider-a:rollback-bet-reference',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const rollbackRequest = {
      providerId: 'provider-a',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'rollback-bet-reference',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    };

    const results = await Promise.all([
      new ProcessWagerTransactionUseCase(repository).execute({
        ...rollbackRequest,
        externalTransactionId: 'rollback-bet-first',
        idempotencyKey: 'provider-a:rollback-bet-first',
      }),
      new ProcessWagerTransactionUseCase(repository).execute({
        ...rollbackRequest,
        externalTransactionId: 'rollback-bet-second',
        idempotencyKey: 'provider-a:rollback-bet-second',
      }),
    ]);
    const processed = results.find(
      ({ transaction }) => transaction.status === 'PROCESSED',
    );
    const rejected = results.find(
      ({ transaction }) => transaction.status === 'REJECTED',
    );

    expect(processed?.transaction.referenceTransactionId).toBe(
      bet.transaction.id,
    );
    expect(rejected?.transaction.failureCode).toBe(
      'REFERENCE_ALREADY_ROLLED_BACK',
    );
    expect(processed?.balance.toString()).toBe('75.00');
    expect(rejected?.balance.toString()).toBe('75.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '75.00', version: 3 }]);
    expect(
      await execute(
        `select "direction", "amount", "balance_before", "balance_after"
         from "wallet_ledger_entries" where "transaction_id" = ?`,
        [processed?.transaction.id],
      ),
    ).toEqual([
      {
        direction: 'CREDIT',
        amount: '25.00',
        balance_before: '50.00',
        balance_after: '75.00',
      },
    ]);
    expect(
      await execute(
        `select count(*)::int as "count"
         from "wallet_ledger_entries"
         where "transaction_id" = ?`,
        [rejected?.transaction.id],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('rolls back WIN and REFUND with inverse ledger directions', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const repository = new MikroOrmProcessWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );
    const processTransaction = new ProcessWagerTransactionUseCase(repository);
    await new ProcessBetUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-refund-bet',
      idempotencyKey: 'provider-a:rollback-refund-bet',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const win = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-win-reference',
      idempotencyKey: 'provider-a:rollback-win-reference',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    const rollbackWin = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-win-operation',
      idempotencyKey: 'provider-a:rollback-win-operation',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'rollback-win-reference',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    const refund = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-refund-operation',
      idempotencyKey: 'provider-a:rollback-refund-operation',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'rollback-refund-bet',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const rollbackRefund = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-refund-rollback',
      idempotencyKey: 'provider-a:rollback-refund-rollback',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'rollback-refund-operation',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(rollbackWin.transaction.status).toBe('PROCESSED');
    expect(rollbackWin.transaction.referenceTransactionId).toBe(win.transaction.id);
    expect(rollbackRefund.transaction.status).toBe('PROCESSED');
    expect(rollbackRefund.transaction.referenceTransactionId).toBe(
      refund.transaction.id,
    );
    expect(rollbackRefund.balance.toString()).toBe('50.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '50.00', version: 6 }]);
    expect(
      await execute(
        `select "direction", "balance_before", "balance_after"
         from "wallet_ledger_entries" where "transaction_id" = ?`,
        [rollbackWin.transaction.id],
      ),
    ).toEqual([
      {
        direction: 'DEBIT',
        balance_before: '60.00',
        balance_after: '50.00',
      },
    ]);
    expect(
      await execute(
        `select "direction", "balance_before", "balance_after"
         from "wallet_ledger_entries" where "transaction_id" = ?`,
        [rollbackRefund.transaction.id],
      ),
    ).toEqual([
      {
        direction: 'DEBIT',
        balance_before: '75.00',
        balance_after: '50.00',
      },
    ]);
  });

  it('keeps ROLLBACK pending for an absent reference and rejects insufficient inverse balance', async () => {
    const wallet = await insertWallet({ balance: '10.00' });
    const repository = new MikroOrmProcessWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );
    const processTransaction = new ProcessWagerTransactionUseCase(repository);
    const pending = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-pending',
      idempotencyKey: 'provider-a:rollback-pending',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'rollback-missing-reference',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const win = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-insufficient-win',
      idempotencyKey: 'provider-a:rollback-insufficient-win',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    await new ProcessBetUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-insufficient-bet',
      idempotencyKey: 'provider-a:rollback-insufficient-bet',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const rejected = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-insufficient-operation',
      idempotencyKey: 'provider-a:rollback-insufficient-operation',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'rollback-insufficient-win',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(pending.transaction.status).toBe('PENDING_REFERENCE');
    expect(rejected.transaction.status).toBe('REJECTED');
    expect(rejected.transaction.failureCode).toBe(
      'ROLLBACK_INSUFFICIENT_FUNDS',
    );
    expect(rejected.transaction.referenceTransactionId).toBeUndefined();
    expect(rejected.balance.toString()).toBe('10.00');
    expect(win.transaction.status).toBe('PROCESSED');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '10.00', version: 3 }]);
    expect(
      await execute(
        `select count(*)::int as "count"
         from "wallet_ledger_entries"
         where "transaction_id" = ?`,
        [rejected.transaction.id],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('rejects ROLLBACK for an ineligible reference or a different amount', async () => {
    const wallet = await insertWallet({ balance: '75.00' });
    const repository = new MikroOrmProcessWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );
    const processTransaction = new ProcessWagerTransactionUseCase(repository);
    await new ProcessBetUseCase(repository).execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-invalid-bet',
      idempotencyKey: 'provider-a:rollback-invalid-bet',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-ineligible-loss',
      idempotencyKey: 'provider-a:rollback-ineligible-loss',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const wrongAmount = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-wrong-amount',
      idempotencyKey: 'provider-a:rollback-wrong-amount',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'rollback-invalid-bet',
      money: Money.from({ amount: '24.99', currency: 'BRL' }),
    });
    const ineligibleReference = await processTransaction.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rollback-loss-reference',
      idempotencyKey: 'provider-a:rollback-loss-reference',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'rollback-ineligible-loss',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(wrongAmount.transaction.status).toBe('REJECTED');
    expect(wrongAmount.transaction.failureCode).toBe(
      'ROLLBACK_AMOUNT_MISMATCH',
    );
    expect(ineligibleReference.transaction.status).toBe('REJECTED');
    expect(ineligibleReference.transaction.failureCode).toBe(
      'INVALID_REFERENCE',
    );
    expect(ineligibleReference.balance.toString()).toBe('50.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '50.00', version: 2 }]);
  });

  it('audits an insufficient-funds BET without changing the wallet or ledger', async () => {
    const wallet = await insertWallet({ balance: '10.00' });
    const result = await new ProcessBetUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    ).execute({
      providerId: 'provider-a',
      externalTransactionId: 'bet-insufficient-1',
      idempotencyKey: 'provider-a:bet-insufficient-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(result.transaction.status).toBe('REJECTED');
    expect(result.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.balance.toString()).toBe('10.00');
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '10.00', version: 1 }]);
    expect(
      await execute(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('replays the original BET result and rejects a changed payload for the same key', async () => {
    const wallet = await insertWallet({ balance: '100.00' });
    const useCase = new ProcessBetUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    );
    const request = {
      providerId: 'provider-a',
      externalTransactionId: 'bet-replay-1',
      idempotencyKey: 'provider-a:bet-replay-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    };

    const first = await useCase.execute(request);
    await useCase.execute({
      ...request,
      externalTransactionId: 'bet-next-1',
      idempotencyKey: 'provider-a:bet-next-1',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    const replay = await useCase.execute(request);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.balance.toString()).toBe('75.00');
    await expect(
      useCase.execute({
        ...request,
        money: Money.from({ amount: '26.00', currency: 'BRL' }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(
      await execute(
        'select "balance" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '65.00' }]);
  });

  it('loads wager transactions by internal ID and provider-scoped external identity', async () => {
    const wallet = await insertWallet({ balance: '100.00' });
    const transaction = await new ProcessBetUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    ).execute({
      providerId: 'provider-query',
      externalTransactionId: 'query-bet-1',
      idempotencyKey: 'provider-query:query-bet-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-query',
      gameId: 'game-query',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const repository = new MikroOrmWagerTransactionsRepository(
      orm.em.fork({ clear: true }),
    );

    const byId = await repository.findById(transaction.transaction.id);
    const byExternalIdentity =
      await repository.findByProviderAndExternalTransactionId(
        'provider-query',
        'query-bet-1',
      );

    expect(byId?.id).toBe(transaction.transaction.id);
    expect(byId?.resultingBalance?.toString()).toBe('75.00');
    expect(byExternalIdentity?.id).toBe(transaction.transaction.id);
    expect(byExternalIdentity?.status).toBe('PROCESSED');
  });

  it('serializes concurrent BETs competing for the same wallet balance', async () => {
    const wallet = await insertWallet({ balance: '100.00' });
    const useCase = new ProcessBetUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    );
    const requests = ['parallel-bet-a', 'parallel-bet-b'].map((id) => ({
      providerId: 'provider-a',
      externalTransactionId: id,
      idempotencyKey: `provider-a:${id}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '80.00', currency: 'BRL' }),
    }));

    const results = await Promise.all(requests.map((request) => useCase.execute(request)));

    expect(results.map(({ transaction }) => transaction.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '20.00', version: 2 }]);
    expect(
      await execute(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('processes parallel requests with the same idempotency key only once', async () => {
    const wallet = await insertWallet({ balance: '100.00' });
    const useCase = new ProcessBetUseCase(
      new MikroOrmProcessWagerTransactionsRepository(
        orm.em.fork({ clear: true }),
      ),
    );
    const request = {
      providerId: 'provider-a',
      externalTransactionId: 'parallel-idempotent-bet',
      idempotencyKey: 'provider-a:parallel-idempotent-bet',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    };

    const results = await Promise.all([
      useCase.execute(request),
      useCase.execute(request),
    ]);

    expect(results[0].transaction.id).toBe(results[1].transaction.id);
    expect(results.filter(({ idempotentReplay }) => !idempotentReplay)).toHaveLength(1);
    expect(results.filter(({ idempotentReplay }) => idempotentReplay)).toHaveLength(1);
    expect(
      await execute(
        'select "balance", "version" from "wallets" where "id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ balance: '75.00', version: 2 }]);
    expect(
      await execute(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
        [wallet.id],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('persists positive initial balance with a processed OPENING transaction and credit ledger atomically', async () => {
    const initialBalance = Money.from({ amount: '250.00', currency: 'BRL' });
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em.fork({ clear: true })),
    ).execute({
      playerId: randomUUID(),
      initialBalance,
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: '250.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);

    const transactions = (await execute(
      `select "kind", "status", "amount", "currency", "processed_at"
       from "wager_transactions" where "wallet_id" = ?`,
      [wallet.id],
    )) as Array<Record<string, string | null>>;
    const ledgerEntries = (await execute(
      `select "direction", "amount", "currency", "balance_before", "balance_after"
       from "wallet_ledger_entries" where "wallet_id" = ?`,
      [wallet.id],
    )) as Array<Record<string, string>>;
    const persistedWallets = (await execute(
      'select "balance", "version" from "wallets" where "id" = ?',
      [wallet.id],
    )) as Array<{ balance: string; version: number }>;

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '250.00',
      currency: 'BRL',
    });
    expect(transactions[0].processed_at).not.toBeNull();
    expect(ledgerEntries).toEqual([
      {
        direction: 'CREDIT',
        amount: '250.00',
        currency: 'BRL',
        balance_before: '0.00',
        balance_after: '250.00',
      },
    ]);
    expect(persistedWallets).toEqual([{ balance: '250.00', version: 1 }]);
  });

  it('creates a zero-balance wallet without an OPENING transaction or ledger entry', async () => {
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em.fork({ clear: true })),
    ).execute({
      playerId: randomUUID(),
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });

    const counts = (await execute(
      `select
        (select count(*) from "wager_transactions" where "wallet_id" = ?) as transactions,
        (select count(*) from "wallet_ledger_entries" where "wallet_id" = ?) as entries`,
      [wallet.id, wallet.id],
    )) as Array<{ transactions: string; entries: string }>;

    expect(Object.values(counts[0]).map(Number)).toEqual([0, 0]);
  });

  it('reconciles the stored balance with ledger totals and reports drift without correcting it', async () => {
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em.fork({ clear: true })),
    ).execute({
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const reconcile = new ReconcileWalletUseCase(
      new MikroOrmWalletReconciliationRepository(orm.em.fork({ clear: true })),
    );

    const consistent = await reconcile.execute(wallet.id);
    expect(consistent).toMatchObject({
      walletId: wallet.id,
      checkedEntries: 1,
      consistent: true,
    });
    expect(consistent.difference.toString()).toBe('0.00');

    await execute('update "wallets" set "balance" = ? where "id" = ?', [
      '101.00',
      wallet.id,
    ]);
    const drifted = await reconcile.execute(wallet.id);

    expect(drifted.storedBalance.toString()).toBe('101.00');
    expect(drifted.calculatedBalance.toString()).toBe('100.00');
    expect(drifted.difference.toString()).toBe('-1.00');
    expect(drifted.consistent).toBe(false);
    expect(drifted.checkedEntries).toBe(1);
    expect(
      await execute('select "balance" from "wallets" where "id" = ?', [
        wallet.id,
      ]),
    ).toEqual([{ balance: '101.00' }]);
  });

  it('rolls back a wallet and its OPENING transaction if the opening ledger entry fails', async () => {
    const initialBalance = Money.from({ amount: '25.00', currency: 'BRL' });
    const wallet = Wallet.open({ playerId: randomUUID(), initialBalance });
    const transaction = WagerTransaction.create({
      providerId: 'internal',
      externalTransactionId: `wallet-opening:${wallet.id}`,
      idempotencyKey: `wallet-opening:${wallet.id}`,
      payloadHash: 'opening-payload-hash',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'wallet-opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
    });
    transaction.markProcessed(undefined, transaction.createdAt);
    const invalidLedgerEntry = WalletLedgerEntry.rehydrate({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero('BRL'),
      balanceAfter: Money.from({ amount: '30.00', currency: 'BRL' }),
      createdAt: transaction.createdAt,
    });

    await expect(
      new MikroOrmWalletsRepository(orm.em).create(wallet, {
        transaction,
        ledgerEntry: invalidLedgerEntry,
      }),
    ).rejects.toThrow();

    const rows = (await execute(
      `select
        (select count(*) from "wallets" where "id" = ?) as wallets,
        (select count(*) from "wager_transactions" where "id" = ?) as transactions,
        (select count(*) from "wallet_ledger_entries" where "transaction_id" = ?) as entries`,
      [wallet.id, transaction.id, transaction.id],
    )) as Array<{ wallets: string; transactions: string; entries: string }>;

    expect(Object.values(rows[0]).map(Number)).toEqual([0, 0, 0]);
  });

  it('enforces wager references and provider-scoped idempotency', async () => {
    const wallet = await insertWallet();

    await expect(
      insertWagerTransaction({
        walletId: randomUUID(),
        playerId: wallet.playerId,
      }),
    ).rejects.toThrow();

    const transaction = {
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: 'external-transaction-1',
      idempotencyKey: 'idempotency-key-1',
    };

    await insertWagerTransaction(transaction);
    await expect(insertWagerTransaction(transaction)).rejects.toThrow();
  });

  it('enforces ledger balance arithmetic and one entry per wallet/transaction', async () => {
    const wallet = await insertWallet();
    const transactionId = await insertWagerTransaction({
      walletId: wallet.id,
      playerId: wallet.playerId,
    });

    const invalidEntry = [
      randomUUID(),
      wallet.id,
      transactionId,
      'DEBIT',
      '25.00',
      'BRL',
      '100.00',
      '80.00',
    ];

    await expect(
      execute(
        `insert into "wallet_ledger_entries" (
          "id", "wallet_id", "transaction_id", "direction", "amount",
          "currency", "balance_before", "balance_after"
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        invalidEntry,
      ),
    ).rejects.toThrow();

    const entry = [
      randomUUID(),
      wallet.id,
      transactionId,
      'DEBIT',
      '25.00',
      'BRL',
      '100.00',
      '75.00',
    ];
    const insertLedgerEntry = () =>
      execute(
        `insert into "wallet_ledger_entries" (
          "id", "wallet_id", "transaction_id", "direction", "amount",
          "currency", "balance_before", "balance_after"
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        entry,
      );

    await insertLedgerEntry();
    await expect(insertLedgerEntry()).rejects.toThrow();
  });

  it('deduplicates Inbox deliveries and Outbox events in PostgreSQL', async () => {
    const inboxMessage = [
      randomUUID(),
      'wager-consumer',
      'integration-source',
      'message-1',
      'WagerTransactionRequested',
      '{}',
      'payload-hash',
    ];
    const insertInboxMessage = () =>
      execute(
        `insert into "inbox_messages" (
          "id", "consumer_name", "source", "message_id", "message_type",
          "payload", "payload_hash"
        ) values (?, ?, ?, ?, ?, ?::jsonb, ?)`,
        inboxMessage,
      );

    await insertInboxMessage();
    await expect(insertInboxMessage()).rejects.toThrow();

    const outboxMessage = [
      randomUUID(),
      'wager-transaction',
      randomUUID(),
      'WagerTransactionProcessed',
      '{}',
      'wager-transaction:event-1',
    ];
    const insertOutboxMessage = () =>
      execute(
        `insert into "outbox_messages" (
          "id", "aggregate_type", "aggregate_id", "event_type", "payload", "deduplication_key"
        ) values (?, ?, ?, ?, ?::jsonb, ?)`,
        outboxMessage,
      );

    await insertOutboxMessage();
    await expect(insertOutboxMessage()).rejects.toThrow();
  });

  it('rolls back wallet, wager, ledger, inbox and outbox writes as one transaction', async () => {
    const wallet = { id: randomUUID(), playerId: randomUUID() };
    const wager = {
      id: randomUUID(),
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    };

    await expect(
      orm.em.transactional(async (entityManager) => {
        const transaction = (sql: string, params: unknown[] = []) =>
          entityManager
            .getConnection()
            .execute(sql, params, 'all', entityManager.getTransactionContext());

        await transaction(
          'insert into "wallets" ("id", "player_id", "currency", "balance", "version") values (?, ?, ?, 100.00, 1)',
          [wallet.id, wallet.playerId, 'BRL'],
        );
        await transaction(
          `insert into "wager_transactions" (
            "id", "provider_id", "external_transaction_id", "idempotency_key",
            "payload_hash", "wallet_id", "player_id", "round_id", "game_id",
            "kind", "amount", "currency", "status"
          ) values (?, 'integration-provider', ?, ?, 'payload-hash', ?, ?, 'round-1', 'game-1', 'BET', 25.00, 'BRL', 'PENDING')`,
          [
            wager.id,
            wager.externalTransactionId,
            wager.idempotencyKey,
            wallet.id,
            wallet.playerId,
          ],
        );
        await transaction(
          `insert into "wallet_ledger_entries" (
            "id", "wallet_id", "transaction_id", "direction", "amount",
            "currency", "balance_before", "balance_after"
          ) values (?, ?, ?, 'DEBIT', 25.00, 'BRL', 100.00, 75.00)`,
          [randomUUID(), wallet.id, wager.id],
        );
        await transaction(
          `insert into "inbox_messages" (
            "id", "consumer_name", "source", "message_id", "message_type", "payload", "payload_hash"
          ) values (?, 'wager-consumer', 'integration-source', 'message-rollback', 'WagerTransactionRequested', '{}'::jsonb, 'payload-hash')`,
          [randomUUID()],
        );
        await transaction(
          `insert into "outbox_messages" (
            "id", "aggregate_type", "aggregate_id", "event_type", "payload"
          ) values (?, 'wager-transaction', ?, 'WagerTransactionProcessed', '{}'::jsonb)`,
          [randomUUID(), wager.id],
        );

        throw new Error('force transaction rollback');
      }),
    ).rejects.toThrow('force transaction rollback');

    const rows = (await execute(
      `
      select
        (select count(*) from "wallets" where "id" = ?) as wallets,
        (select count(*) from "wager_transactions" where "id" = ?) as wager_transactions,
        (select count(*) from "wallet_ledger_entries" where "transaction_id" = ?) as ledger_entries,
        (select count(*) from "inbox_messages" where "message_id" = ?) as inbox_messages,
        (select count(*) from "outbox_messages" where "aggregate_id" = ?) as outbox_messages
    `,
      [wallet.id, wager.id, wager.id, 'message-rollback', wager.id],
    )) as Array<Record<string, string>>;

    expect(Object.values(rows[0]).map(Number)).toEqual([0, 0, 0, 0, 0]);
  });

  it('can roll back and reapply every migration', async () => {
    const migrationCount = (await execute(
      'select count(*)::int as count from "mikro_orm_migrations"',
    )) as Array<{ count: number }>;

    for (let index = 0; index < migrationCount[0].count; index += 1) {
      await orm.migrator.down();
    }

    const tablesAfterDown = (await execute(`
      select
        to_regclass('public.inbox_messages')::text as inbox,
        to_regclass('public.outbox_messages')::text as outbox,
        to_regclass('public.wallet_ledger_entries')::text as ledger,
        to_regclass('public.wager_transactions')::text as wagers,
        to_regclass('public.wallets')::text as wallets
    `)) as Array<{
      inbox: string | null;
      outbox: string | null;
      ledger: string | null;
      wagers: string | null;
      wallets: string | null;
    }>;

    expect(tablesAfterDown[0]).toEqual({
      inbox: null,
      outbox: null,
      ledger: null,
      wagers: null,
      wallets: null,
    });

    await orm.migrator.up();

    const tablesAfterUp = (await execute(`
      select
        to_regclass('public.inbox_messages')::text as inbox,
        to_regclass('public.outbox_messages')::text as outbox,
        to_regclass('public.wallet_ledger_entries')::text as ledger,
        to_regclass('public.wager_transactions')::text as wagers,
        to_regclass('public.wallets')::text as wallets
    `)) as Array<{
      inbox: string | null;
      outbox: string | null;
      ledger: string | null;
      wagers: string | null;
      wallets: string | null;
    }>;

    expect(tablesAfterUp[0]).toEqual({
      inbox: 'inbox_messages',
      outbox: 'outbox_messages',
      ledger: 'wallet_ledger_entries',
      wagers: 'wager_transactions',
      wallets: 'wallets',
    });
  });
});
