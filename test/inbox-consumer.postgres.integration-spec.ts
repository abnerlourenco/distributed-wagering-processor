import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { mikroOrmConfig } from '../src/infra/database/mikro-orm.config.js';
import {
  InboxPayloadConflictError,
  MikroOrmInboxConsumerRepository,
} from '../src/infra/messaging/inbox/mikro-orm-inbox-consumer.repository.js';
import { OutboxEventConsumer } from '../src/infra/messaging/inbox/outbox-event-consumer.js';
import { SqsMessageAdapter } from '../src/infra/messaging/sqs/sqs-message-adapter.js';
import type { OutboxEvent } from '../src/infra/messaging/inbox/outbox-event.schema.js';

const testDatabaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const testDatabaseName = testDatabaseUrl
  ? new URL(testDatabaseUrl).pathname.slice(1)
  : '';

if (!testDatabaseUrl || !/(^|[-_])test$/i.test(testDatabaseName)) {
  throw new Error(
    'POSTGRES_TEST_DATABASE_URL must point to a dedicated PostgreSQL database ending in _test or -test',
  );
}

describe('Inbox event consumer with PostgreSQL and LocalStack', () => {
  let orm: MikroORM;
  let client: SQSClient;
  let adapter: SqsMessageAdapter;
  let repository: MikroOrmInboxConsumerRepository;
  let queueName: string | undefined;
  let queueUrl: string | undefined;
  let consumer: OutboxEventConsumer;

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
    repository = new MikroOrmInboxConsumerRepository(orm.em);

    queueName = `inbox-consumer-test-${randomUUID()}`;
    const queue = await client.send(
      new CreateQueueCommand({ QueueName: queueName }),
    );
    if (!queue.QueueUrl) {
      throw new Error('LocalStack did not return the test queue URL');
    }
    queueUrl = queue.QueueUrl;
    consumer = new OutboxEventConsumer(repository, adapter, queueName, 1);
  });

  afterEach(async () => {
    await orm.em.getConnection().execute(
      `delete from "inbox_messages"
       where "consumer_name" = 'wagering-outbox-event-consumer'
         and "source" = ?`,
      [queueName],
    );
  });

  afterAll(async () => {
    if (queueUrl) {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    client?.destroy();
    await orm?.close(true);
  });

  function createEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
    const messageId = randomUUID();
    return {
      messageId,
      aggregateType: 'wager-transaction',
      aggregateId: randomUUID(),
      eventType: 'WagerTransactionProcessed',
      occurredAt: new Date().toISOString(),
      payload: {
        transactionId: randomUUID(),
        providerId: 'integration-provider',
        externalTransactionId: randomUUID(),
        walletId: randomUUID(),
        playerId: randomUUID(),
        roundId: 'integration-round',
        gameId: 'integration-game',
        kind: 'BET',
        amount: '1.25',
        currency: 'BRL',
        referenceTransactionId: null,
        resultingBalance: '98.75',
        processedAt: new Date().toISOString(),
      },
      ...overrides,
    };
  }

  async function enqueue(event: OutboxEvent): Promise<void> {
    if (!queueUrl) {
      throw new Error('The LocalStack integration test queue is unavailable');
    }
    await adapter.sendMessage(queueUrl, JSON.stringify(event));
  }

  it('records a message before acknowledging it and deduplicates redeliveries', async () => {
    if (!queueUrl) {
      throw new Error('The LocalStack integration test queue is unavailable');
    }
    const event = createEvent();
    await enqueue(event);
    await enqueue(event);

    expect(await consumer.consumeOne()).toBe(true);
    expect(await consumer.consumeOne()).toBe(true);
    expect(await consumer.consumeOne()).toBe(false);

    const rows = await orm.em
      .getConnection()
      .execute<Array<{ message_id: string; status: string; attempts: number }>>(
        `select "message_id", "status", "attempts"
       from "inbox_messages"
       where "consumer_name" = 'wagering-outbox-event-consumer'
         and "source" = ?
         and "message_id" = ?`,
        [queueName, event.messageId],
      );
    expect(rows).toEqual([
      { message_id: event.messageId, status: 'RECEIVED', attempts: 0 },
    ]);
  });

  it('keeps a conflicting message unacknowledged when its ID has a different payload', async () => {
    if (!queueUrl) {
      throw new Error('The LocalStack integration test queue is unavailable');
    }
    const event = createEvent();
    await enqueue(event);
    await enqueue({
      ...event,
      payload: { ...event.payload, amount: '2.50' },
    });

    expect(await consumer.consumeOne()).toBe(true);
    await expect(consumer.consumeOne()).rejects.toThrow(
      InboxPayloadConflictError,
    );
    expect(await consumer.consumeOne()).toBe(false);

    const rows = await orm.em.getConnection().execute<Array<{ count: number }>>(
      `select count(*)::int as "count"
       from "inbox_messages"
       where "consumer_name" = 'wagering-outbox-event-consumer'
         and "source" = ?
         and "message_id" = ?`,
      [queueName, event.messageId],
    );
    expect(rows).toEqual([{ count: 1 }]);
  });
});
