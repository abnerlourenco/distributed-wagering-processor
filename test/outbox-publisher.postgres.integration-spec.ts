import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { mikroOrmConfig } from '../src/infra/database/mikro-orm.config.js';
import { MikroOrmOutboxPublisherRepository } from '../src/infra/messaging/outbox/mikro-orm-outbox-publisher.repository.js';
import { OutboxPublisher } from '../src/infra/messaging/outbox/outbox-publisher.js';
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

describe('Outbox publisher with PostgreSQL and LocalStack integration', () => {
  let orm: MikroORM;
  let client: SQSClient;
  let adapter: SqsMessageAdapter;
  let repository: MikroOrmOutboxPublisherRepository;
  let queueName: string | undefined;
  let queueUrl: string | undefined;
  let outboxMessageId: string | undefined;

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
    repository = new MikroOrmOutboxPublisherRepository(orm.em);

    queueName = `outbox-publisher-test-${randomUUID()}`;
    const queue = await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { MaximumMessageSize: '1024' },
      }),
    );
    if (!queue.QueueUrl) {
      throw new Error('LocalStack did not return the test queue URL');
    }
    queueUrl = queue.QueueUrl;
  });

  beforeEach(async () => {
    outboxMessageId = randomUUID();
    await orm.em.getConnection().execute(
      `insert into "outbox_messages" (
        "id", "aggregate_type", "aggregate_id", "event_type", "payload"
      ) values (?, ?, ?, ?, ?::jsonb)`,
      [
        outboxMessageId,
        'integration-test',
        outboxMessageId,
        'PublisherIntegrationTest',
        JSON.stringify({ marker: outboxMessageId }),
      ],
    );
  });

  afterEach(async () => {
    if (outboxMessageId) {
      await orm.em
        .getConnection()
        .execute('delete from "outbox_messages" where "id" = ?', [
          outboxMessageId,
        ]);
    }
  });

  afterAll(async () => {
    if (queueUrl) {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    client?.destroy();
    await orm?.close(true);
  });

  it('claims once across concurrent publishers and marks the event published after SQS accepts it', async () => {
    if (!queueName || !queueUrl || !outboxMessageId) {
      throw new Error('The publisher integration test was not initialized');
    }

    const firstPublisher = new OutboxPublisher(repository, adapter, queueName);
    const secondPublisher = new OutboxPublisher(repository, adapter, queueName);
    const results = await Promise.all([
      firstPublisher.publishAvailable(),
      secondPublisher.publishAvailable(),
    ]);

    expect(results.reduce((total, result) => total + result.published, 0)).toBe(
      1,
    );

    const received = await adapter.receiveMessage(queueUrl);
    if (!received) {
      throw new Error('The published outbox event was not received from SQS');
    }

    expect(JSON.parse(received.body)).toMatchObject({
      messageId: outboxMessageId,
      aggregateType: 'integration-test',
      aggregateId: outboxMessageId,
      eventType: 'PublisherIntegrationTest',
      payload: { marker: outboxMessageId },
    });
    await adapter.deleteMessage(queueUrl, received.receiptHandle);

    const rows = await orm.em
      .getConnection()
      .execute<
        Array<{ status: string; attempts: number; publishedAt: Date | string }>
      >(
        'select "status", "attempts", "published_at" as "publishedAt" from "outbox_messages" where "id" = ?',
        [outboxMessageId],
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PUBLISHED', attempts: 1 });
    expect(rows[0]?.publishedAt).toBeTruthy();
  });

  it('marks an SQS-rejected event failed and schedules a retry', async () => {
    if (!queueName || !outboxMessageId) {
      throw new Error('The publisher integration test was not initialized');
    }

    await orm.em
      .getConnection()
      .execute(
        'update "outbox_messages" set "payload" = ?::jsonb where "id" = ?',
        [JSON.stringify({ oversized: 'x'.repeat(2048) }), outboxMessageId],
      );

    const publisher = new OutboxPublisher(repository, adapter, queueName);
    const result = await publisher.publishAvailable();

    expect(result).toEqual({ published: 0, failed: 1 });

    const rows = await orm.em.getConnection().execute<
      Array<{
        status: string;
        attempts: number;
        availableAt: Date | string;
        lastErrorCode: string | null;
      }>
    >(
      `select
        "status",
        "attempts",
        "available_at" as "availableAt",
        "last_error_code" as "lastErrorCode"
      from "outbox_messages"
      where "id" = ?`,
      [outboxMessageId],
    );
    const row = rows[0];

    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 1,
    });
    if (!row) {
      throw new Error('The failed outbox message was not persisted');
    }
    expect(row.lastErrorCode).toBeTruthy();
    expect(new Date(row.availableAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('moves an Outbox message to DEAD after the maximum publication attempts', async () => {
    if (!queueName || !outboxMessageId) {
      throw new Error('The publisher integration test was not initialized');
    }

    await orm.em.getConnection().execute(
      `update "outbox_messages"
       set "payload" = ?::jsonb, "attempts" = 4
       where "id" = ?`,
      [JSON.stringify({ oversized: 'x'.repeat(2048) }), outboxMessageId],
    );

    const publisher = new OutboxPublisher(repository, adapter, queueName);
    expect(await publisher.publishAvailable()).toEqual({
      published: 0,
      failed: 1,
    });

    const rows = await orm.em.getConnection().execute<
      Array<{
        status: string;
        attempts: number;
        lastErrorCode: string | null;
      }>
    >(
      `select "status", "attempts", "last_error_code" as "lastErrorCode"
       from "outbox_messages"
       where "id" = ?`,
      [outboxMessageId],
    );
    expect(rows).toEqual([
      {
        status: 'DEAD',
        attempts: 5,
        lastErrorCode: expect.stringMatching(
          /^MAX_PUBLISH_ATTEMPTS_OUTCOME_UNKNOWN:/,
        ),
      },
    ]);
  });
});
