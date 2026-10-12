import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../src/core/domain/money.js';
import { IdempotencyConflictError } from '../src/domain/wagering/application/errors/idempotency-conflict-error.js';
import { QueueWagerTransactionUseCase } from '../src/domain/wagering/application/use-cases/queue-wager-transaction.js';
import { ProcessWagerTransactionUseCase } from '../src/domain/wagering/application/use-cases/process-wager-transaction.js';
import { WagerTransactionKind } from '../src/domain/wagering/enterprise/entities/wager-transaction.js';
import { OpenWalletUseCase } from '../src/domain/wallets/application/use-cases/open-wallet.js';
import { mikroOrmConfig } from '../src/infra/database/mikro-orm.config.js';
import { MikroOrmProcessWagerTransactionsRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-process-wager-transactions.repository.js';
import { MikroOrmQueueWagerTransactionsRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-queue-wager-transactions.repository.js';
import { MikroOrmWalletsRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-wallets.repository.js';
import { MikroOrmInboxConsumerRepository } from '../src/infra/messaging/inbox/mikro-orm-inbox-consumer.repository.js';
import { OutboxEventConsumer } from '../src/infra/messaging/inbox/outbox-event-consumer.js';
import { MikroOrmOutboxPublisherRepository } from '../src/infra/messaging/outbox/mikro-orm-outbox-publisher.repository.js';
import { OutboxPublisher } from '../src/infra/messaging/outbox/outbox-publisher.js';
import { WagerCommandConsumer } from '../src/infra/messaging/commands/wager-command-consumer.js';
import { SqsMessageAdapter } from '../src/infra/messaging/sqs/sqs-message-adapter.js';

const testDatabaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const testDatabaseName = testDatabaseUrl
  ? new URL(testDatabaseUrl).pathname.slice(1)
  : '';

if (!testDatabaseUrl || !/(^|[-_])test$/i.test(testDatabaseName)) {
  throw new Error(
    'POSTGRES_TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test or -test',
  );
}

describe('Wager commands through PostgreSQL and LocalStack', () => {
  let orm: MikroORM;
  let client: SQSClient;
  let adapter: SqsMessageAdapter;
  let commandQueueName: string | undefined;
  let commandQueueUrl: string | undefined;
  let eventQueueName: string | undefined;
  let eventQueueUrl: string | undefined;
  let walletId: string | undefined;
  const transactionIds: string[] = [];
  let commandConsumer: WagerCommandConsumer;
  let eventConsumer: OutboxEventConsumer;
  let publisher: OutboxPublisher;

  beforeAll(async () => {
    orm = await MikroORM.init({
      ...mikroOrmConfig,
      clientUrl: testDatabaseUrl,
    });
    await orm.migrator.up();

    client = new SQSClient({
      endpoint: process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });
    adapter = new SqsMessageAdapter(client);

    commandQueueName = `wager-command-flow-${randomUUID()}.fifo`;
    eventQueueName = `wager-command-events-${randomUUID()}`;
    const [commandQueue, eventQueue] = await Promise.all([
      client.send(
        new CreateQueueCommand({
          QueueName: commandQueueName,
          Attributes: { FifoQueue: 'true' },
        }),
      ),
      client.send(new CreateQueueCommand({ QueueName: eventQueueName })),
    ]);
    if (!commandQueue.QueueUrl || !eventQueue.QueueUrl) {
      throw new Error('LocalStack did not return the integration queue URLs');
    }
    commandQueueUrl = commandQueue.QueueUrl;
    eventQueueUrl = eventQueue.QueueUrl;

    publisher = new OutboxPublisher(
      new MikroOrmOutboxPublisherRepository(orm.em),
      adapter,
      eventQueueName,
      commandQueueName,
    );
    commandConsumer = new WagerCommandConsumer(
      new ProcessWagerTransactionUseCase(
        new MikroOrmProcessWagerTransactionsRepository(orm.em),
      ),
      adapter,
      commandQueueName,
      1,
    );
    eventConsumer = new OutboxEventConsumer(
      new MikroOrmInboxConsumerRepository(orm.em),
      adapter,
      eventQueueName,
      1,
    );
  });

  afterEach(async () => {
    if (eventQueueName && transactionIds.length > 0) {
      const transactionPlaceholders = transactionIds.map(() => '?').join(', ');
      await orm.em.getConnection().execute(
        `delete from "inbox_messages"
           where "consumer_name" = 'wagering-outbox-event-consumer'
             and "source" = ?
           and "message_id" in (
               select "id"::text from "outbox_messages"
               where "event_type" = 'WagerTransactionProcessed'
                 and "aggregate_id" in (${transactionPlaceholders})
             )`,
        [eventQueueName, ...transactionIds],
      );
    }
    if (walletId) {
      await orm.em
        .getConnection()
        .execute('delete from "wallet_ledger_entries" where "wallet_id" = ?', [
          walletId,
        ]);
      await orm.em
        .getConnection()
        .execute('delete from "wager_transactions" where "wallet_id" = ?', [
          walletId,
        ]);
      await orm.em
        .getConnection()
        .execute('delete from "wallets" where "id" = ?', [walletId]);
      await orm.em.getConnection().execute(
        `delete from "outbox_messages"
         where "aggregate_type" = 'wager-wallet' and "aggregate_id" = ?`,
        [walletId],
      );
      if (transactionIds.length > 0) {
        const transactionPlaceholders = transactionIds
          .map(() => '?')
          .join(', ');
        await orm.em.getConnection().execute(
          `delete from "outbox_messages"
           where "aggregate_type" = 'wager-transaction'
             and "aggregate_id" in (${transactionPlaceholders})`,
          transactionIds,
        );
      }
      walletId = undefined;
    }
    transactionIds.length = 0;
  });

  afterAll(async () => {
    if (commandQueueUrl) {
      await client.send(new DeleteQueueCommand({ QueueUrl: commandQueueUrl }));
    }
    if (eventQueueUrl) {
      await client.send(new DeleteQueueCommand({ QueueUrl: eventQueueUrl }));
    }
    client?.destroy();
    await orm?.close(true);
  });

  it('processes every wager operation through the command and event queues', async () => {
    const playerId = randomUUID();
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em),
    ).execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    walletId = wallet.id;

    const queueTransaction = new QueueWagerTransactionUseCase(
      new MikroOrmQueueWagerTransactionsRepository(orm.em),
    );
    const runId = randomUUID();
    const operations = [
      {
        externalTransactionId: 'bet-1',
        kind: WagerTransactionKind.Bet,
        amount: '5.00',
      },
      {
        externalTransactionId: 'win-1',
        kind: WagerTransactionKind.Win,
        amount: '7.00',
        referenceExternalTransactionId: 'bet-1',
      },
      {
        externalTransactionId: 'loss-1',
        kind: WagerTransactionKind.Loss,
        amount: '4.00',
      },
      {
        externalTransactionId: 'refund-1',
        kind: WagerTransactionKind.Refund,
        amount: '5.00',
        referenceExternalTransactionId: 'bet-1',
      },
      {
        externalTransactionId: 'rollback-1',
        kind: WagerTransactionKind.Rollback,
        amount: '7.00',
        referenceExternalTransactionId: 'win-1',
      },
    ];

    for (const operation of operations) {
      const externalTransactionId = `${runId}-${operation.externalTransactionId}`;
      const request = {
        providerId: 'integration-provider',
        externalTransactionId,
        idempotencyKey: `${runId}:${operation.externalTransactionId}`,
        walletId,
        playerId,
        roundId: 'integration-round',
        gameId: 'integration-game',
        kind: operation.kind,
        money: Money.from({ amount: operation.amount, currency: 'BRL' }),
        ...(operation.referenceExternalTransactionId
          ? {
              referenceExternalTransactionId: `${runId}-${operation.referenceExternalTransactionId}`,
            }
          : {}),
      };
      const queueResults =
        operation.externalTransactionId === 'bet-1'
          ? await Promise.all([
              queueTransaction.execute(request),
              queueTransaction.execute(request),
            ])
          : [await queueTransaction.execute(request)];
      const queued = queueResults[0];
      if (!queued) {
        throw new Error('The wagering command was not accepted');
      }
      transactionIds.push(queued.transaction.id);

      expect(queued.transaction.status).toBe('PENDING');
      if (operation.externalTransactionId === 'bet-1') {
        expect(queueResults).toHaveLength(2);
        expect(queueResults[1]?.transaction.id).toBe(queued.transaction.id);
        expect(
          queueResults
            .map((result) => result.idempotentReplay)
            .sort((left, right) => Number(left) - Number(right)),
        ).toEqual([false, true]);
        await expect(
          queueTransaction.execute({
            ...request,
            money: Money.from({ amount: '6.00', currency: 'BRL' }),
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
        const requestRows = await orm.em
          .getConnection()
          .execute<Array<{ count: number }>>(
            `select count(*)::int as "count" from "outbox_messages"
           where "deduplication_key" = ?`,
            [`wager-transaction:${queued.transaction.id}:requested`],
          );
        expect(requestRows).toEqual([{ count: 1 }]);
      }
      expect((await publisher.publishAvailable()).published).toBeGreaterThan(0);
      expect(await commandConsumer.consumeOne()).toBe(true);
    }

    const transactionRows = await orm.em.getConnection().execute<
      Array<{
        external_transaction_id: string;
        kind: string;
        status: string;
        resulting_balance: string;
      }>
    >(
      `select "external_transaction_id", "kind", "status", "resulting_balance"
       from "wager_transactions"
       where "id" in (${transactionIds.map(() => '?').join(', ')})`,
      transactionIds,
    );
    expect(
      Object.fromEntries(
        transactionRows.map(
          ({ external_transaction_id, status, resulting_balance }) => [
            external_transaction_id.replace(`${runId}-`, ''),
            [status, resulting_balance],
          ],
        ),
      ),
    ).toEqual({
      'bet-1': ['PROCESSED', '95.00'],
      'win-1': ['PROCESSED', '102.00'],
      'loss-1': ['PROCESSED', '102.00'],
      'refund-1': ['PROCESSED', '107.00'],
      'rollback-1': ['PROCESSED', '100.00'],
    });

    const walletRows = await orm.em
      .getConnection()
      .execute<Array<{ balance: string }>>(
        'select "balance" from "wallets" where "id" = ?',
        [walletId],
      );
    expect(walletRows).toEqual([{ balance: '100.00' }]);

    const ledgerRows = await orm.em
      .getConnection()
      .execute<Array<{ count: number }>>(
        'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
        [walletId],
      );
    expect(ledgerRows).toEqual([{ count: 5 }]);

    await publisher.publishAvailable();
    for (let index = 0; index < transactionIds.length; index += 1) {
      expect(await eventConsumer.consumeOne()).toBe(true);
    }

    const inboxRows = await orm.em
      .getConnection()
      .execute<Array<{ count: number }>>(
        `select count(*)::int as "count" from "inbox_messages"
       where "consumer_name" = 'wagering-outbox-event-consumer'
         and "source" = ?
         and "message_type" = 'WagerTransactionProcessed'
         and "status" = 'RECEIVED'`,
        [eventQueueName],
      );
    expect(inboxRows).toEqual([{ count: 5 }]);
  });
});
