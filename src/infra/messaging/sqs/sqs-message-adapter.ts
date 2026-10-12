import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export interface ReceivedSqsMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
}

export class SqsMessageAdapter {
  constructor(private readonly client: SQSClient) {}

  async getQueueUrl(queueName: string): Promise<string> {
    const result = await this.client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );

    if (!result.QueueUrl) {
      throw new Error(`SQS did not return a URL for queue "${queueName}"`);
    }

    return result.QueueUrl;
  }

  async sendMessage(queueUrl: string, body: string): Promise<string> {
    const result = await this.client.send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }),
    );

    if (!result.MessageId) {
      throw new Error('SQS did not return a message ID after sending');
    }

    return result.MessageId;
  }

  async receiveMessage(
    queueUrl: string,
    waitTimeSeconds = 10,
  ): Promise<ReceivedSqsMessage | undefined> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitTimeSeconds,
      }),
    );
    const message = result.Messages?.[0];

    if (!message) {
      return undefined;
    }

    if (
      !message.MessageId ||
      !message.ReceiptHandle ||
      message.Body === undefined
    ) {
      throw new Error('SQS returned a message without required fields');
    }

    return {
      messageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body,
    };
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }
}
