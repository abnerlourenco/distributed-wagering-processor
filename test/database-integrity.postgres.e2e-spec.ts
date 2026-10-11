import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { mikroOrmConfig } from '../src/infra/database/mikro-orm.config.js';

const testDatabaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const testDatabaseName = testDatabaseUrl ? new URL(testDatabaseUrl).pathname.slice(1) : '';

if (!testDatabaseUrl || !/(^|[-_])test$/i.test(testDatabaseName)) {
  throw new Error(
    'POSTGRES_TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test or -test',
  );
}

describe('PostgreSQL migrations and integrity constraints', () => {
  let orm: MikroORM;

  async function execute(sql: string, params: unknown[] = []): Promise<unknown> {
    return orm.em.getConnection().execute(sql, params);
  }

  async function insertWallet(props: {
    id?: string;
    playerId?: string;
    currency?: string;
    balance?: string;
  } = {}): Promise<{ id: string; playerId: string }> {
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
        'wallet_ledger_entries_balance_consistent',
        'inbox_messages_consumer_source_message_unique',
        'outbox_messages_deduplication_key_unique'
      )
    `)) as Array<{ conname: string }>;

    expect(constraints.map(({ conname }) => conname).sort()).toEqual([
      'inbox_messages_consumer_source_message_unique',
      'outbox_messages_deduplication_key_unique',
      'wager_transactions_provider_idempotency_key_unique',
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
          [wager.id, wager.externalTransactionId, wager.idempotencyKey, wallet.id, wallet.playerId],
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

    const rows = (await execute(`
      select
        (select count(*) from "wallets" where "id" = ?) as wallets,
        (select count(*) from "wager_transactions" where "id" = ?) as wager_transactions,
        (select count(*) from "wallet_ledger_entries" where "transaction_id" = ?) as ledger_entries,
        (select count(*) from "inbox_messages" where "message_id" = ?) as inbox_messages,
        (select count(*) from "outbox_messages" where "aggregate_id" = ?) as outbox_messages
    `, [wallet.id, wager.id, wager.id, 'message-rollback', wager.id])) as Array<Record<string, string>>;

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
