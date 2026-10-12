import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SqsMessageAdapter } from '../src/infra/messaging/sqs/sqs-message-adapter.js';

describe('SQS LocalStack integration', () => {
  let client: SQSClient;
  let adapter: SqsMessageAdapter;
  let queueUrl: string | undefined;

  function getQueueUrl(): string {
    if (!queueUrl) {
      throw new Error('The LocalStack integration test queue is unavailable');
    }
    return queueUrl;
  }

  beforeAll(async () => {
    client = new SQSClient({
      endpoint: process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });
    adapter = new SqsMessageAdapter(client);

    const queue = await client.send(
      new CreateQueueCommand({
        QueueName: `sqs-adapter-test-${randomUUID()}`,
      }),
    );
    if (!queue.QueueUrl) {
      throw new Error('LocalStack did not return the test queue URL');
    }

    queueUrl = queue.QueueUrl;
  });

  afterAll(async () => {
    if (queueUrl) {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    client.destroy();
  });

  it('sends, receives, and deletes a message', async () => {
    const body = JSON.stringify({
      testId: randomUUID(),
      event: 'adapter-check',
    });
    const testQueueUrl = getQueueUrl();
    const sentMessageId = await adapter.sendMessage(testQueueUrl, body);
    const receivedMessage = await adapter.receiveMessage(testQueueUrl);
    if (!receivedMessage) {
      throw new Error('LocalStack did not return the sent test message');
    }

    expect(receivedMessage).toMatchObject({
      messageId: sentMessageId,
      body,
    });

    await adapter.deleteMessage(testQueueUrl, receivedMessage.receiptHandle);
  });
});
