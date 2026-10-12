import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ChangeMessageVisibilityCommand,
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
import { MikroOrmPendingReferenceRetriesRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-pending-reference-retries.repository.js';
import { MikroOrmQueueWagerTransactionsRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-queue-wager-transactions.repository.js';
import { MikroOrmWalletsRepository } from '../src/infra/database/mikro-orm/repositories/mikro-orm-wallets.repository.js';
import { MikroOrmInboxConsumerRepository } from '../src/infra/messaging/inbox/mikro-orm-inbox-consumer.repository.js';
import { OutboxEventConsumer } from '../src/infra/messaging/inbox/outbox-event-consumer.js';
import { MikroOrmOutboxPublisherRepository } from '../src/infra/messaging/outbox/mikro-orm-outbox-publisher.repository.js';
import { OutboxPublisher } from '../src/infra/messaging/outbox/outbox-publisher.js';
import { WagerCommandConsumer } from '../src/infra/messaging/commands/wager-command-consumer.js';
import { SqsMessageAdapter } from '../src/infra/messaging/sqs/sqs-message-adapter.js';
import { MAX_PENDING_REFERENCE_ATTEMPTS } from '../src/domain/wagering/application/policies/pending-reference-retry-policy.js';

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
      new MikroOrmInboxConsumerRepository(orm.em),
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
    await orm.em.getConnection().execute(`
      TRUNCATE TABLE
        outbox_messages,
        inbox_messages,
        wallet_ledger_entries,
        wager_transactions,
        wallets
      RESTART IDENTITY CASCADE;
    `);

    walletId = undefined;
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

    const commandInboxRows = await orm.em
      .getConnection()
      .execute<Array<{ count: number }>>(
        `select count(*)::int as "count" from "inbox_messages"
         where "consumer_name" = 'wager-transaction-command-consumer'
           and "source" = 'wager-transactions.fifo'
           and "message_type" = 'WagerTransactionRequested'
           and "status" = 'RECEIVED'
           and "message_id" in (
             select "id"::text from "outbox_messages"
             where "event_type" = 'WagerTransactionRequested'
               and "aggregate_id" = ?
           )`,
        [walletId],
      );
    expect(commandInboxRows).toEqual([{ count: 5 }]);

      if (!commandQueueUrl || !walletId) {
        throw new Error('The command queue or test wallet is unavailable');
      }
      const commandRows = await orm.em.getConnection().execute<
        Array<{
          id: string;
          occurred_at: Date | string;
          payload: Record<string, unknown>;
        }>
      >(
        `select "id", "occurred_at", "payload"
         from "outbox_messages"
         where "event_type" = 'WagerTransactionRequested'
           and "aggregate_id" = ?
         order by "occurred_at", "id"
         limit 1`,
        [walletId],
      );
      const command = commandRows[0];
      if (!command) {
        throw new Error('The test command was not written to the Outbox');
      }
      const { amount, currency, ...data } = command.payload;
      await adapter.sendMessage(
        commandQueueUrl,
        JSON.stringify({
          messageId: command.id,
          type: 'WagerTransactionRequested',
          occurredAt: new Date(command.occurred_at).toISOString(),
          data: { ...data, money: { amount, currency } },
        }),
        {
          messageGroupId: walletId,
          messageDeduplicationId: randomUUID(),
        },
      );
      expect(await commandConsumer.consumeOne()).toBe(true);
      const replayedWalletRows = await orm.em
        .getConnection()
        .execute<Array<{ balance: string }>>(
          'select "balance" from "wallets" where "id" = ?',
          [walletId],
        );
      expect(replayedWalletRows).toEqual([{ balance: '100.00' }]);
      const replayedLedgerRows = await orm.em
        .getConnection()
        .execute<Array<{ count: number }>>(
          'select count(*)::int as "count" from "wallet_ledger_entries" where "wallet_id" = ?',
          [walletId],
        );
      expect(replayedLedgerRows).toEqual([{ count: 5 }]);

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

  it('moves a poison command to its FIFO DLQ after the receive limit', async () => {
    if (!client) {
      throw new Error('LocalStack client is unavailable');
    }

    const poisonQueueName = `wager-poison-${randomUUID()}.fifo`;
    const deadLetterQueueName = `wager-poison-dlq-${randomUUID()}.fifo`;
    let poisonQueueUrl: string | undefined;
    let deadLetterQueueUrl: string | undefined;

    try {
      const deadLetterQueue = await client.send(
        new CreateQueueCommand({
          QueueName: deadLetterQueueName,
          Attributes: { FifoQueue: 'true' },
        }),
      );
      deadLetterQueueUrl = deadLetterQueue.QueueUrl;
      if (!deadLetterQueueUrl) {
        throw new Error('LocalStack did not return the DLQ URL');
      }

      const attributes = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: deadLetterQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      const deadLetterQueueArn = attributes.Attributes?.QueueArn;
      if (!deadLetterQueueArn) {
        throw new Error('LocalStack did not return the DLQ ARN');
      }

      const poisonQueue = await client.send(
        new CreateQueueCommand({
          QueueName: poisonQueueName,
          Attributes: {
            FifoQueue: 'true',
            VisibilityTimeout: '0',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: deadLetterQueueArn,
              maxReceiveCount: '2',
            }),
          },
        }),
      );
      poisonQueueUrl = poisonQueue.QueueUrl;
      if (!poisonQueueUrl) {
        throw new Error('LocalStack did not return the source queue URL');
      }

      await adapter.sendMessage(poisonQueueUrl, '{}', {
        messageGroupId: 'poison-test-wallet',
        messageDeduplicationId: randomUUID(),
      });

      const poisonConsumer = new WagerCommandConsumer(
        new ProcessWagerTransactionUseCase(
          new MikroOrmProcessWagerTransactionsRepository(orm.em),
        ),
        new MikroOrmInboxConsumerRepository(orm.em),
        adapter,
        poisonQueueName,
        1,
      );

      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!(await poisonConsumer.consumeOne())) {
          break;
        }
      }

      const deadLetter = await adapter.receiveMessage(deadLetterQueueUrl, 1);
      expect(deadLetter?.body).toBe('{}');
    } finally {
      if (poisonQueueUrl) {
        await client.send(new DeleteQueueCommand({ QueueUrl: poisonQueueUrl }));
      }
      if (deadLetterQueueUrl) {
        await client.send(
          new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }),
        );
      }
    }
  });

  
  it('moves a poison event to its DLQ without acknowledging it', async () => {
    if (!client) {
      throw new Error('LocalStack client is unavailable');
    }

    const sourceQueueName = `wager-event-poison-${randomUUID()}`;
    const deadLetterQueueName = `wager-event-poison-dlq-${randomUUID()}`;

    let sourceQueueUrl: string | undefined;
    let deadLetterQueueUrl: string | undefined;

    try {
      const deadLetterQueue = await client.send(
        new CreateQueueCommand({
          QueueName: deadLetterQueueName,
          Attributes: {
            MessageRetentionPeriod: '1209600',
          },
        }),
      );

      deadLetterQueueUrl = deadLetterQueue.QueueUrl;

      if (!deadLetterQueueUrl) {
        throw new Error('LocalStack did not return the event DLQ URL');
      }

      const attributes = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: deadLetterQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );

      const deadLetterQueueArn = attributes.Attributes?.QueueArn;

      if (!deadLetterQueueArn) {
        throw new Error('LocalStack did not return the event DLQ ARN');
      }

      const sourceQueue = await client.send(
        new CreateQueueCommand({
          QueueName: sourceQueueName,
          Attributes: {
            VisibilityTimeout: '0',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: deadLetterQueueArn,
              maxReceiveCount: '2',
            }),
          },
        }),
      );

      sourceQueueUrl = sourceQueue.QueueUrl;

      if (!sourceQueueUrl) {
        throw new Error('LocalStack did not return the source queue URL');
      }

      await adapter.sendMessage(sourceQueueUrl, '{}');

      const poisonConsumer = new OutboxEventConsumer(
        new MikroOrmInboxConsumerRepository(orm.em),
        adapter,
        sourceQueueName,
        1,
      );

      let rejectedAttempts = 0;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const consumed = await poisonConsumer.consumeOne();

          if (!consumed) {
            break;
          }
        } catch {
          rejectedAttempts += 1;
        }
      }

      expect(rejectedAttempts).toBeGreaterThan(0);

      const deadLetter = await adapter.receiveMessage(
        deadLetterQueueUrl,
        1,
      );

      expect(deadLetter?.body).toBe('{}');
    } finally {
      if (sourceQueueUrl) {
        await client.send(
          new DeleteQueueCommand({ QueueUrl: sourceQueueUrl }),
        );
      }

      if (deadLetterQueueUrl) {
        await client.send(
          new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }),
        );
      }
    }
  });

  it('marks an accepted operation FAILED after the Outbox publication limit', async () => {
    const playerId = randomUUID();
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em),
    ).execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    walletId = wallet.id;

    const queued = await new QueueWagerTransactionUseCase(
      new MikroOrmQueueWagerTransactionsRepository(orm.em),
    ).execute({
      providerId: 'integration-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId,
      playerId,
      roundId: 'integration-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
    });
    transactionIds.push(queued.transaction.id);

    const deduplicationKey = `wager-transaction:${queued.transaction.id}:requested`;
    await orm.em.getConnection().execute(
      `update "outbox_messages"
       set "payload" = ?::jsonb, "attempts" = 4
       where "deduplication_key" = ?`,
      [
        JSON.stringify({
          transactionId: queued.transaction.id,
          oversized: 'x'.repeat(2048),
        }),
        deduplicationKey,
      ],
    );

    expect(await publisher.publishAvailable()).toEqual({
      published: 0,
      failed: 1,
    });

    const outboxRows = await orm.em
      .getConnection()
      .execute<Array<{ status: string; attempts: number }>>(
        `select "status", "attempts" from "outbox_messages"
       where "deduplication_key" = ?`,
        [deduplicationKey],
      );
    expect(outboxRows).toEqual([{ status: 'DEAD', attempts: 5 }]);

    const wagerRows = await orm.em
      .getConnection()
      .execute<Array<{ status: string; failure_code: string }>>(
        `select "status", "failure_code" from "wager_transactions"
       where "id" = ?`,
        [queued.transaction.id],
      );
    expect(wagerRows).toEqual([
      {
        status: 'FAILED',
        failure_code: 'COMMAND_PUBLISH_ATTEMPTS_EXCEEDED',
      },
    ]);
  });

  it('keeps an operation pending after an ambiguous SQS delivery retry', async () => {
    if (!commandQueueName || !eventQueueName) {
      throw new Error('The command flow test was not initialized');
    }

    const playerId = randomUUID();
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em),
    ).execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    walletId = wallet.id;

    const queued = await new QueueWagerTransactionUseCase(
      new MikroOrmQueueWagerTransactionsRepository(orm.em),
    ).execute({
      providerId: 'integration-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: wallet.id,
      playerId,
      roundId: 'integration-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
    });
    transactionIds.push(queued.transaction.id);

    const sendMessage = vi
      .spyOn(adapter, 'sendMessage')
      .mockRejectedValueOnce(new Error('ambiguous SQS delivery timeout'));
    try {
      const publisherWithTwoAttempts = new OutboxPublisher(
        new MikroOrmOutboxPublisherRepository(orm.em),
        adapter,
        eventQueueName,
        commandQueueName,
        2,
      );
      expect(await publisherWithTwoAttempts.publishAvailable()).toEqual({
        published: 0,
        failed: 1,
      });
    } finally {
      sendMessage.mockRestore();
    }

    await orm.em.getConnection().execute(
      `update "outbox_messages"
       set "available_at" = current_timestamp
       where "deduplication_key" = ?`,
      [`wager-transaction:${queued.transaction.id}:requested`],
    );

    const getQueueUrl = vi
      .spyOn(adapter, 'getQueueUrl')
      .mockRejectedValueOnce(new Error('queue lookup failed before send'));
    try {
      const retryingPublisher = new OutboxPublisher(
        new MikroOrmOutboxPublisherRepository(orm.em),
        adapter,
        eventQueueName,
        commandQueueName,
        2,
      );
      expect(await retryingPublisher.publishAvailable()).toEqual({
        published: 0,
        failed: 1,
      });
    } finally {
      getQueueUrl.mockRestore();
    }

    const outboxRows = await orm.em
      .getConnection()
      .execute<Array<{ status: string; lastErrorCode: string | null }>>(
        `select "status", "last_error_code" as "lastErrorCode"
       from "outbox_messages"
       where "deduplication_key" = ?`,
        [`wager-transaction:${queued.transaction.id}:requested`],
      );
    expect(outboxRows).toEqual([
      {
        status: 'DEAD',
        lastErrorCode: expect.stringMatching(
          /^MAX_PUBLISH_ATTEMPTS_OUTCOME_UNKNOWN:/,
        ),
      },
    ]);

    const wagerRows = await orm.em
      .getConnection()
      .execute<Array<{ status: string; failure_code: string | null }>>(
        `select "status", "failure_code" from "wager_transactions"
       where "id" = ?`,
        [queued.transaction.id],
      );
    expect(wagerRows).toEqual([{ status: 'PENDING', failure_code: null }]);
  });

  it('reprocesses a pending reference when the referenced transaction arrives', async () => {
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
    const processTransaction = new ProcessWagerTransactionUseCase(
      new MikroOrmProcessWagerTransactionsRepository(orm.em),
    );
    const waitingWin = await queueTransaction.execute({
      providerId: 'integration-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId,
      playerId,
      roundId: 'reference-retry-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'late-bet-reference',
    });
    transactionIds.push(waitingWin.transaction.id);

    const processRequest = (transaction: typeof waitingWin.transaction) =>
      processTransaction.execute({
        transactionId: transaction.id,
        createdAt: transaction.createdAt,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId,
      });

    expect(
      (await processRequest(waitingWin.transaction)).transaction.status,
    ).toBe('PENDING_REFERENCE');

    const bet = await queueTransaction.execute({
      providerId: 'integration-provider',
      externalTransactionId: 'late-bet-reference',
      idempotencyKey: randomUUID(),
      walletId,
      playerId,
      roundId: 'reference-retry-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    transactionIds.push(bet.transaction.id);
    await processRequest(bet.transaction);

    await orm.em.getConnection().execute(
      `update "wager_transactions"
       set "reference_next_attempt_at" = current_timestamp
       where "id" = ?`,
      [waitingWin.transaction.id],
    );

    const retryRepository = new MikroOrmPendingReferenceRetriesRepository(
      orm.em,
    );
    const dueTransactions = await retryRepository.claimDue(10);
    expect(dueTransactions.map(({ id }) => id)).toContain(
      waitingWin.transaction.id,
    );

    const waitingRetry = dueTransactions.find(
      ({ id }) => id === waitingWin.transaction.id,
    );
    if (!waitingRetry) {
      throw new Error('Pending reference was not claimed for retry');
    }
    const retried = await processTransaction.execute({
      transactionId: waitingRetry.id,
      createdAt: new Date(waitingRetry.createdAt),
      providerId: waitingRetry.providerId,
      externalTransactionId: waitingRetry.externalTransactionId,
      idempotencyKey: waitingRetry.idempotencyKey,
      walletId: waitingRetry.walletId,
      playerId: waitingRetry.playerId,
      roundId: waitingRetry.roundId,
      gameId: waitingRetry.gameId,
      kind: waitingRetry.kind,
      money: Money.from({
        amount: waitingRetry.amount,
        currency: waitingRetry.currency,
      }),
      referenceExternalTransactionId:
        waitingRetry.referenceExternalTransactionId,
    });

    expect(retried.transaction.status).toBe('PROCESSED');
    expect(retried.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(retried.balance.toString()).toBe('95.00');
    const retryRows = await orm.em.getConnection().execute<
      Array<{
        reference_retry_attempts: number;
        reference_next_attempt_at: Date | null;
      }>
    >(
      `select "reference_retry_attempts", "reference_next_attempt_at"
       from "wager_transactions"
       where "id" = ?`,
      [waitingWin.transaction.id],
    );
    expect(retryRows).toEqual([
      { reference_retry_attempts: 1, reference_next_attempt_at: null },
    ]);
  });

  it('rejects an unresolved reference after the retry limit and writes an event', async () => {
    const playerId = randomUUID();
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em),
    ).execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    walletId = wallet.id;

    const queued = await new QueueWagerTransactionUseCase(
      new MikroOrmQueueWagerTransactionsRepository(orm.em),
    ).execute({
      providerId: 'integration-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId,
      playerId,
      roundId: 'reference-expiration-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'never-arriving-bet',
    });
    transactionIds.push(queued.transaction.id);

    const processTransaction = new ProcessWagerTransactionUseCase(
      new MikroOrmProcessWagerTransactionsRepository(orm.em),
    );
    await processTransaction.execute({
      transactionId: queued.transaction.id,
      createdAt: queued.transaction.createdAt,
      providerId: queued.transaction.providerId,
      externalTransactionId: queued.transaction.externalTransactionId,
      idempotencyKey: queued.transaction.idempotencyKey,
      walletId: queued.transaction.walletId,
      playerId,
      roundId: queued.transaction.roundId,
      gameId: queued.transaction.gameId,
      kind: queued.transaction.kind,
      money: queued.transaction.money,
      referenceExternalTransactionId:
        queued.transaction.referenceExternalTransactionId,
    });
    await orm.em.getConnection().execute(
      `update "wager_transactions"
       set "reference_retry_attempts" = ?,
           "reference_next_attempt_at" = current_timestamp
       where "id" = ?`,
      [MAX_PENDING_REFERENCE_ATTEMPTS - 1, queued.transaction.id],
    );

    const [retry] = await new MikroOrmPendingReferenceRetriesRepository(
      orm.em,
    ).claimDue(1);
    if (!retry) {
      throw new Error('Pending reference was not claimed for retry');
    }

    const result = await processTransaction.execute({
      transactionId: retry.id,
      createdAt: new Date(retry.createdAt),
      providerId: retry.providerId,
      externalTransactionId: retry.externalTransactionId,
      idempotencyKey: retry.idempotencyKey,
      walletId: retry.walletId,
      playerId: retry.playerId,
      roundId: retry.roundId,
      gameId: retry.gameId,
      kind: retry.kind,
      money: Money.from({ amount: retry.amount, currency: retry.currency }),
      referenceExternalTransactionId: retry.referenceExternalTransactionId,
    });

    expect(result.transaction.status).toBe('REJECTED');
    expect(result.transaction.failureCode).toBe(
      'REFERENCE_TRANSACTION_NOT_FOUND',
    );
    const ledgerRows = await orm.em
      .getConnection()
      .execute<Array<{ count: number }>>(
        `select count(*)::int as "count"
         from "wallet_ledger_entries"
         where "wallet_id" = ?`,
        [walletId],
      );
    expect(ledgerRows).toEqual([{ count: 1 }]);
    const walletRows = await orm.em
      .getConnection()
      .execute<Array<{ balance: string }>>(
        'select "balance" from "wallets" where "id" = ?',
        [walletId],
      );
    expect(walletRows).toEqual([{ balance: '100.00' }]);
    const eventRows = await orm.em.getConnection().execute<
      Array<{
        id: string;
        event_type: string;
        payload: { failureCode: string };
      }>
    >(
      `select "id", "event_type", "payload"
       from "outbox_messages"
       where "deduplication_key" = ?`,
      [`wager-transaction:${queued.transaction.id}:rejected`],
    );
    expect(eventRows).toMatchObject([
      {
        id: expect.any(String),
        event_type: 'WagerTransactionRejected',
        payload: { failureCode: 'REFERENCE_TRANSACTION_NOT_FOUND' },
      },
    ]);

    if (!eventQueueUrl || !eventRows[0]) {
      throw new Error('The rejection event or event queue is unavailable');
    }
    await publisher.publishAvailable();
    if (!(await eventConsumer.consumeOne())) {
      throw new Error('The rejection event was not published to SQS');
    }
    const inboxRows = await orm.em
      .getConnection()
      .execute<Array<{ message_type: string; status: string }>>(
        `select "message_type", "status"
       from "inbox_messages"
       where "consumer_name" = 'wagering-outbox-event-consumer'
         and "source" = ?
         and "message_id" = ?`,
        [eventQueueName, eventRows[0].id],
      );
    expect(inboxRows).toEqual([
      {
        message_type: 'WagerTransactionRejected',
        status: 'RECEIVED',
      },
    ]);
  });
  
  it('processes 50 concurrent duplicate BET requests only once', async () => {
    const playerId = randomUUID();
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em),
    ).execute({
      playerId,
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    walletId = wallet.id;

    const request = {
      providerId: 'concurrency-provider',
      externalTransactionId: 'concurrent-bet-001',
      idempotencyKey: 'concurrent-bet-key-001',
      walletId: wallet.id,
      playerId,
      roundId: 'concurrency-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({
        amount: '10.00',
        currency: 'BRL',
      }),
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        new ProcessWagerTransactionUseCase(
          new MikroOrmProcessWagerTransactionsRepository(
            orm.em.fork({ clear: true }),
          ),
        ).execute(request),
      ),
    );

    expect(
      results.every((result) => result.transaction.status === 'PROCESSED'),
    ).toBe(true);

    expect(
      new Set(results.map((result) => result.transaction.id)).size,
    ).toBe(1);

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(49);

    const transactionId = results[0]!.transaction.id;

    const balanceRows = await orm.em.getConnection().execute<
      Array<{ balance: string }>
    >(
      'select "balance" from "wallets" where "id" = ?',
      [wallet.id],
    );

    expect(balanceRows).toEqual([{ balance: '90.00' }]);

    const transactionRows = await orm.em.getConnection().execute<
      Array<{ count: number }>
    >(
      `select count(*)::int as "count"
      from "wager_transactions"
      where "provider_id" = ?
        and "external_transaction_id" = ?`,
      [request.providerId, request.externalTransactionId],
    );

    expect(transactionRows).toEqual([{ count: 1 }]);

    const ledgerRows = await orm.em.getConnection().execute<
      Array<{ count: number }>
    >(
      `select count(*)::int as "count"
      from "wallet_ledger_entries"
      where "wallet_id" = ?
        and "transaction_id" = ?`,
      [wallet.id, transactionId],
    );

    expect(ledgerRows).toEqual([{ count: 1 }]);

    const outboxRows = await orm.em.getConnection().execute<
      Array<{ count: number }>
    >(
      `select count(*)::int as "count"
      from "outbox_messages"
      where "aggregate_id" = ?
        and "event_type" = 'WagerTransactionProcessed'`,
      [transactionId],
    );

    expect(outboxRows).toEqual([{ count: 1 }]);
  });
  
  it('does not overspend a wallet when different BETs race concurrently', async () => {
    const playerId = randomUUID();
    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em),
    ).execute({
      playerId,
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    walletId = wallet.id;

    const requests = Array.from({ length: 20 }, (_, index) => ({
      providerId: 'concurrent-spending-provider',
      externalTransactionId: `concurrent-spending-${index}`,
      idempotencyKey: `concurrent-spending-key-${index}`,
      walletId: wallet.id,
      playerId,
      roundId: 'concurrent-spending-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({
        amount: '10.00',
        currency: 'BRL',
      }),
    }));

    const results = await Promise.all(
      requests.map((request) =>
        new ProcessWagerTransactionUseCase(
          new MikroOrmProcessWagerTransactionsRepository(
            orm.em.fork({ clear: true }),
          ),
        ).execute(request),
      ),
    );

    const processed = results.filter(
      (result) => result.transaction.status === 'PROCESSED',
    );
    const rejected = results.filter(
      (result) => result.transaction.status === 'REJECTED',
    );

    expect(processed).toHaveLength(10);
    expect(rejected).toHaveLength(10);

    expect(
      rejected.every(
        (result) => result.transaction.failureCode === 'INSUFFICIENT_FUNDS',
      ),
    ).toBe(true);

    const balanceRows = await orm.em.getConnection().execute<
      Array<{ balance: string }>
    >(
      'select "balance" from "wallets" where "id" = ?',
      [wallet.id],
    );

    expect(balanceRows).toEqual([{ balance: '0.00' }]);

    const ledgerRows = await orm.em.getConnection().execute<
      Array<{ count: number; total: string }>
    >(
      `select count(*)::int as "count",
              coalesce(sum("amount"), 0)::text as "total"
      from "wallet_ledger_entries"
      where "wallet_id" = ?
        and "transaction_id" in (
          select "id"
          from "wager_transactions"
          where "provider_id" = ?
            and "external_transaction_id" like 'concurrent-spending-%'
        )`,
      [wallet.id, 'concurrent-spending-provider'],
    );

    expect(ledgerRows).toEqual([{ count: 10, total: '100.00' }]);

    const transactionRows = await orm.em.getConnection().execute<
      Array<{ count: number }>
    >(
      `select count(*)::int as "count"
      from "wager_transactions"
      where "provider_id" = ?
        and "external_transaction_id" like 'concurrent-spending-%'`,
      ['concurrent-spending-provider'],
    );

    expect(transactionRows).toEqual([{ count: 20 }]);
  });
  
  it('processes bets concurrently across different wallets', async () => {
    const players = [
      { playerId: randomUUID(), balance: '100.00' },
      { playerId: randomUUID(), balance: '100.00' },
    ];

    const wallets = await Promise.all(
      players.map(async ({ playerId, balance }) => {
        const { wallet } = await new OpenWalletUseCase(
          new MikroOrmWalletsRepository(orm.em.fork({ clear: true })),
        ).execute({
          playerId,
          initialBalance: Money.from({
            amount: balance,
            currency: 'BRL',
          }),
        });

        return wallet;
      }),
    );

    // 20 apostas independentes: 10 para cada carteira.
    const requests = Array.from({ length: 20 }, (_, index) => {
      const walletIndex = index % 2;
      const wallet = wallets[walletIndex];
      const player = players[walletIndex];

      return {
        providerId: 'parallel-wallets-provider',
        externalTransactionId: `parallel-wallet-${index}`,
        idempotencyKey: `parallel-wallet-key-${index}`,
        walletId: wallet.id,
        playerId: player.playerId,
        roundId: 'parallel-wallets-round',
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: Money.from({
          amount: '10.00',
          currency: 'BRL',
        }),
      };
    });

    const results = await Promise.all(
      requests.map((request) =>
        new ProcessWagerTransactionUseCase(
          new MikroOrmProcessWagerTransactionsRepository(
            orm.em.fork({ clear: true }),
          ),
        ).execute(request),
      ),
    );

    expect(
      results.filter((result) => result.transaction.status === 'PROCESSED'),
    ).toHaveLength(20);

    expect(
      results.filter((result) => result.transaction.status === 'REJECTED'),
    ).toHaveLength(0);

    for (const wallet of wallets) {

      const rows = await orm.em.getConnection().execute<
        Array<{
          balance: string;
          ledger_count: number;
          wager_ledger_count: number;
        }>
      >(
        `select
          w."balance",
          (
            select count(*)::int
            from "wallet_ledger_entries" l
            where l."wallet_id" = w."id"
          ) as "ledger_count",
          (
            select count(*)::int
            from "wallet_ledger_entries" l
            join "wager_transactions" t
              on t."id" = l."transaction_id"
            where l."wallet_id" = w."id"
              and t."provider_id" = ?
              and t."external_transaction_id" like 'parallel-wallet-%'
          ) as "wager_ledger_count"
        from "wallets" w
        where w."id" = ?`,
        ['parallel-wallets-provider', wallet.id],
      );

      expect(rows).toEqual([
        {
          balance: '0.00',
          ledger_count: 11,
          wager_ledger_count: 10,
        },
      ]);

    }
  });

  it('does not refund the same BET twice under concurrent requests', async () => {
    const playerId = randomUUID();
    const providerId = 'concurrent-refund-provider';

    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em.fork({ clear: true })),
    ).execute({
      playerId,
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    const process = (request: {
      providerId: string;
      externalTransactionId: string;
      idempotencyKey: string;
      walletId: string;
      playerId: string;
      roundId: string;
      gameId: string;
      kind: WagerTransactionKind;
      money: Money;
      referenceExternalTransactionId?: string;
    }) =>
      new ProcessWagerTransactionUseCase(
        new MikroOrmProcessWagerTransactionsRepository(
          orm.em.fork({ clear: true }),
        ),
      ).execute(request);

    const bet = {
      providerId,
      externalTransactionId: 'refund-source-bet',
      idempotencyKey: 'refund-source-bet-key',
      walletId: wallet.id,
      playerId,
      roundId: 'concurrent-refund-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    };

    const betResult = await process(bet);
    expect(betResult.transaction.status).toBe('PROCESSED');

    const refunds = Array.from({ length: 2 }, (_, index) => ({
      ...bet,
      externalTransactionId: `refund-attempt-${index}`,
      idempotencyKey: `refund-attempt-key-${index}`,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    }));

    const results = await Promise.allSettled(
      refunds.map((refund) => process(refund)),
    );

    const fulfilled = results.filter(
      (result) => result.status === 'fulfilled',
    );

    const processedRefunds = fulfilled.filter(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.transaction.status === 'PROCESSED',
    );

    expect(processedRefunds).toHaveLength(1);

    const walletRows = await orm.em.getConnection().execute<
      Array<{ balance: string }>
    >(
      'select "balance" from "wallets" where "id" = ?',
      [wallet.id],
    );

    expect(walletRows).toEqual([{ balance: '100.00' }]);

    const refundRows = await orm.em.getConnection().execute<
      Array<{ count: number; total: string }>
    >(
      `select
        count(*)::int as "count",
        coalesce(sum("amount"), 0)::text as "total"
      from "wallet_ledger_entries"
      where "wallet_id" = ?
        and "transaction_id" in (
          select "id"
          from "wager_transactions"
          where "provider_id" = ?
            and "kind" = 'REFUND'
            and "reference_external_transaction_id" = ?
            and "status" = 'PROCESSED'
        )`,
      [wallet.id, providerId, bet.externalTransactionId],
    );

    expect(refundRows).toEqual([{ count: 1, total: '10.00' }]);
  });
  
  it('does not roll back the same BET twice under concurrent requests', async () => {
    const playerId = randomUUID();
    const providerId = 'concurrent-rollback-provider';

    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em.fork({ clear: true })),
    ).execute({
      playerId,
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    const process = (request: {
      providerId: string;
      externalTransactionId: string;
      idempotencyKey: string;
      walletId: string;
      playerId: string;
      roundId: string;
      gameId: string;
      kind: WagerTransactionKind;
      money: Money;
      referenceExternalTransactionId?: string;
    }) =>
      new ProcessWagerTransactionUseCase(
        new MikroOrmProcessWagerTransactionsRepository(
          orm.em.fork({ clear: true }),
        ),
      ).execute(request);

    const bet = {
      providerId,
      externalTransactionId: 'rollback-source-bet',
      idempotencyKey: 'rollback-source-bet-key',
      walletId: wallet.id,
      playerId,
      roundId: 'concurrent-rollback-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    };

    const betResult = await process(bet);
    expect(betResult.transaction.status).toBe('PROCESSED');
    expect(betResult.balance.toString()).toBe('90.00');

    const rollbacks = Array.from({ length: 2 }, (_, index) => ({
      ...bet,
      externalTransactionId: `rollback-attempt-${index}`,
      idempotencyKey: `rollback-attempt-key-${index}`,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: bet.externalTransactionId,
    }));

    const results = await Promise.allSettled(
      rollbacks.map((rollback) => process(rollback)),
    );

    const processedRollbacks = results.filter(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.transaction.status === 'PROCESSED',
    );

    expect(processedRollbacks).toHaveLength(1);

    const walletRows = await orm.em.getConnection().execute<
      Array<{ balance: string }>
    >(
      'select "balance" from "wallets" where "id" = ?',
      [wallet.id],
    );

    expect(walletRows).toEqual([{ balance: '100.00' }]);

    const rollbackRows = await orm.em.getConnection().execute<
      Array<{ count: number; total: string }>
    >(
      `select
        count(*)::int as "count",
        coalesce(sum("amount"), 0)::text as "total"
      from "wallet_ledger_entries"
      where "wallet_id" = ?
        and "transaction_id" in (
          select "id"
          from "wager_transactions"
          where "provider_id" = ?
            and "kind" = 'ROLLBACK'
            and "reference_external_transaction_id" = ?
            and "status" = 'PROCESSED'
        )`,
      [wallet.id, providerId, bet.externalTransactionId],
    );

    expect(rollbackRows).toEqual([{ count: 1, total: '10.00' }]);
  });
  
  it('preserves idempotency across three independent database connections', async () => {
    const playerId = randomUUID();
    const providerId = 'three-connections-provider';
    const externalTransactionId = 'three-connections-bet';
    const idempotencyKey = 'three-connections-key';

    const { wallet } = await new OpenWalletUseCase(
      new MikroOrmWalletsRepository(orm.em.fork({ clear: true })),
    ).execute({
      playerId,
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    const independentOrms: MikroORM[] = [];

    try {
      for (let index = 0; index < 3; index += 1) {
        independentOrms.push(
          await MikroORM.init({
            ...mikroOrmConfig,
            clientUrl: testDatabaseUrl,
          }),
        );
      }

      const request = {
        providerId,
        externalTransactionId,
        idempotencyKey,
        walletId: wallet.id,
        playerId,
        roundId: 'three-connections-round',
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: Money.from({
          amount: '10.00',
          currency: 'BRL',
        }),
      };

      const results = await Promise.all(
        Array.from({ length: 30 }, (_, index) => {
          const independentOrm = independentOrms[index % 3];

          if (!independentOrm) {
            throw new Error('Independent ORM connection is unavailable');
          }

          return new ProcessWagerTransactionUseCase(
            new MikroOrmProcessWagerTransactionsRepository(
              independentOrm.em.fork({ clear: true }),
            ),
          ).execute(request);
        }),
      );

      expect(
        results.filter((result) => !result.idempotentReplay),
      ).toHaveLength(1);

      expect(
        results.filter((result) => result.idempotentReplay),
      ).toHaveLength(29);

      expect(
        results.every(
          (result) => result.transaction.status === 'PROCESSED',
        ),
      ).toBe(true);

      const walletRows = await orm.em.getConnection().execute<
        Array<{ balance: string }>
      >(
        'select "balance" from "wallets" where "id" = ?',
        [wallet.id],
      );

      expect(walletRows).toEqual([{ balance: '90.00' }]);

      const transactionRows = await orm.em.getConnection().execute<
        Array<{ count: number }>
      >(
        `select count(*)::int as "count"
        from "wager_transactions"
        where "provider_id" = ?
          and "external_transaction_id" = ?`,
        [providerId, externalTransactionId],
      );

      expect(transactionRows).toEqual([{ count: 1 }]);

      const ledgerRows = await orm.em.getConnection().execute<
        Array<{ count: number; total: string }>
      >(
        `select
          count(*)::int as "count",
          coalesce(sum("amount"), 0)::text as "total"
        from "wallet_ledger_entries"
        where "wallet_id" = ?
          and "transaction_id" in (
            select "id"
            from "wager_transactions"
            where "provider_id" = ?
              and "external_transaction_id" = ?
          )`,
        [wallet.id, providerId, externalTransactionId],
      );

      expect(ledgerRows).toEqual([{ count: 1, total: '10.00' }]);
    } finally {
      await Promise.all(
        independentOrms.map((independentOrm) =>
          independentOrm.close(true),
        ),
      );
    }
  });
  
  it('does not apply a wager twice when ACK fails after the database commit', async () => {
    if (!eventQueueName) {
      throw new Error('The event queue is unavailable');
    }

    const testQueueName = `ack-failure-${randomUUID()}.fifo`;
    let testQueueUrl: string | undefined;

    let deleteSpy: ReturnType<typeof vi.spyOn> | undefined;
    let visibilitySpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      const createdQueue = await client.send(
        new CreateQueueCommand({
          QueueName: testQueueName,
          Attributes: {
            FifoQueue: 'true',
            VisibilityTimeout: '0',
          },
        }),
      );

      testQueueUrl = createdQueue.QueueUrl;

      if (!testQueueUrl) {
        throw new Error('Could not create the ACK failure test queue');
      }

      const testPublisher = new OutboxPublisher(
        new MikroOrmOutboxPublisherRepository(orm.em),
        adapter,
        eventQueueName,
        testQueueName,
      );

      const testConsumer = new WagerCommandConsumer(
        new ProcessWagerTransactionUseCase(
          new MikroOrmProcessWagerTransactionsRepository(orm.em),
        ),
        new MikroOrmInboxConsumerRepository(orm.em),
        adapter,
        testQueueName,
        1,
      );

      const playerId = randomUUID();

      const { wallet } = await new OpenWalletUseCase(
        new MikroOrmWalletsRepository(orm.em),
      ).execute({
        playerId,
        initialBalance: Money.from({
          amount: '100.00',
          currency: 'BRL',
        }),
      });

      walletId = wallet.id;

      const queued = await new QueueWagerTransactionUseCase(
        new MikroOrmQueueWagerTransactionsRepository(orm.em),
      ).execute({
        providerId: 'integration-provider',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        walletId: wallet.id,
        playerId,
        roundId: 'ack-failure-round',
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: Money.from({
          amount: '10.00',
          currency: 'BRL',
        }),
      });

      transactionIds.push(queued.transaction.id);

      const publishResult = await testPublisher.publishAvailable();
      expect(publishResult.published).toBeGreaterThan(0);

      // Simula falha no ACK depois do processamento financeiro.
      deleteSpy = vi
        .spyOn(adapter, 'deleteMessage')
        .mockRejectedValueOnce(new Error('simulated ACK failure'));

      // Torna a mensagem imediatamente disponível para redelivery.
      visibilitySpy = vi
        .spyOn(adapter, 'changeMessageVisibility')
        .mockImplementation(async (queueUrl, receiptHandle) => {
          await client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: 0,
            }),
          );
        });

      // Primeira entrega: processa a aposta, mas falha ao confirmar o ACK.
      expect(await testConsumer.consumeOne()).toBe(true);

      // Segunda entrega: deve reconhecer a operação já processada.
      expect(await testConsumer.consumeOne()).toBe(true);

      const balanceRows = await orm.em.getConnection().execute<
        Array<{ balance: string }>
      >(
        'select "balance" from "wallets" where "id" = ?',
        [wallet.id],
      );

      expect(balanceRows).toEqual([{ balance: '90.00' }]);

      const ledgerRows = await orm.em.getConnection().execute<
        Array<{ count: number }>
      >(
        `select count(*)::int as "count"
        from "wallet_ledger_entries"
        where "wallet_id" = ?
          and "transaction_id" = ?`,
        [wallet.id, queued.transaction.id],
      );

      expect(ledgerRows).toEqual([{ count: 1 }]);

      const transactionRows = await orm.em.getConnection().execute<
        Array<{ status: string }>
      >(
        'select "status" from "wager_transactions" where "id" = ?',
        [queued.transaction.id],
      );

      expect(transactionRows).toEqual([{ status: 'PROCESSED' }]);
    } finally {
      deleteSpy?.mockRestore();
      visibilitySpy?.mockRestore();

      if (testQueueUrl) {
        await client.send(
          new DeleteQueueCommand({
            QueueUrl: testQueueUrl,
          }),
        );
      }
    }
  });

});
