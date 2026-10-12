
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

describe('SQS retry and DLQ integration', () => {
  let client: SQSClient;

  const createdQueueUrls: string[] = [];

  async function createQueue(
    queueName: string,
    attributes?: Record<string, string>,
  ): Promise<string> {
    const result = await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: attributes,
      }),
    );

    if (!result.QueueUrl) {
      throw new Error(`Could not create queue: ${queueName}`);
    }

    createdQueueUrls.push(result.QueueUrl);
    return result.QueueUrl;
  }

  async function getQueueArn(queueUrl: string): Promise<string> {
    const result = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );

    const arn = result.Attributes?.QueueArn;

    if (!arn) {
      throw new Error('SQS did not return the queue ARN');
    }

    return arn;
  }

  async function createQueuePair(
    enableRedrive = true,
  ): Promise<{
    sourceQueueUrl: string;
    dlqUrl: string;
  }> {
    const suffix = randomUUID();

    const dlqUrl = await createQueue(`retry-dlq-${suffix}`);
    const dlqArn = await getQueueArn(dlqUrl);

    const attributes: Record<string, string> = {
      VisibilityTimeout: '2',
    };

    if (enableRedrive) {
      attributes.RedrivePolicy = JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: '2',
      });
    }

    const sourceQueueUrl = await createQueue(
      `retry-source-${suffix}`,
      attributes,
    );

    return { sourceQueueUrl, dlqUrl };
  }

  async function receiveMessage(queueUrl: string) {
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        AttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    return result.Messages?.[0];
  }

  async function waitForMessage(
    queueUrl: string,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const message = await receiveMessage(queueUrl);

      if (message) {
        return message;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return undefined;
  }

  beforeAll(async () => {
    client = new SQSClient({
      endpoint:
        process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  });

  afterAll(async () => {
    for (const queueUrl of [...createdQueueUrls].reverse()) {
      try {
        await client.send(
          new DeleteQueueCommand({ QueueUrl: queueUrl }),
        );
      } catch {
      }
    }

    client.destroy();
  });

  it(
    'makes a message available again when it is not acknowledged',
    async () => {
      const { sourceQueueUrl } = await createQueuePair(false);

      const body = JSON.stringify({
        testId: randomUUID(),
        event: 'retry-check',
      });

      await client.send(
        new SendMessageCommand({
          QueueUrl: sourceQueueUrl,
          MessageBody: body,
        }),
      );

      const firstDelivery = await receiveMessage(sourceQueueUrl);

      expect(firstDelivery?.Body).toBe(body);
      expect(firstDelivery?.ReceiptHandle).toBeDefined();
      expect(firstDelivery?.Attributes?.ApproximateReceiveCount).toBe('1');

      await new Promise((resolve) => setTimeout(resolve, 2_200));

      const secondDelivery = await receiveMessage(sourceQueueUrl);

      expect(secondDelivery?.Body).toBe(body);
      expect(secondDelivery?.Attributes?.ApproximateReceiveCount).toBe('2');
    },
    10_000,
  );

  it(
    'moves a repeatedly received message to its own DLQ',
    async () => {
      const { sourceQueueUrl, dlqUrl } = await createQueuePair(true);

      const body = JSON.stringify({
        testId: randomUUID(),
        event: 'dead-letter-check',
      });

      await client.send(
        new SendMessageCommand({
          QueueUrl: sourceQueueUrl,
          MessageBody: body,
        }),
      );

      const firstDelivery = await receiveMessage(sourceQueueUrl);

      expect(firstDelivery?.Body).toBe(body);
      expect(firstDelivery?.Attributes?.ApproximateReceiveCount).toBe('1');

      await new Promise((resolve) => setTimeout(resolve, 2_200));

      const secondDelivery = await receiveMessage(sourceQueueUrl);

      expect(secondDelivery?.Body).toBe(body);
      expect(secondDelivery?.Attributes?.ApproximateReceiveCount).toBe('2');

      await new Promise((resolve) => setTimeout(resolve, 2_200));
      await receiveMessage(sourceQueueUrl);

      const deadLetterMessage = await waitForMessage(dlqUrl, 10_000);

      expect(
        deadLetterMessage,
        'Message did not arrive in the DLQ',
      ).toBeDefined();

      expect(deadLetterMessage?.Body).toBe(body);

      expect(
        deadLetterMessage,
        'Message did not arrive in the DLQ',
      ).toBeDefined();

      expect(deadLetterMessage?.Body).toBe(body);
    },
    20_000,
  );
});
