import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../env.js';
import { MikroOrmOutboxPublisherRepository } from './outbox/mikro-orm-outbox-publisher.repository.js';
import { OutboxPublisher } from './outbox/outbox-publisher.js';
import { OutboxPublisherWorker } from './outbox/outbox-publisher.worker.js';
import { SqsMessageAdapter } from './sqs/sqs-message-adapter.js';

const SQS_CLIENT = Symbol('SQS_CLIENT');

@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: () =>
        new SQSClient({
          endpoint: env.LOCALSTACK_ENDPOINT,
          region: env.AWS_REGION,
          credentials: {
            accessKeyId: 'test',
            secretAccessKey: 'test',
          },
        }),
    },
    {
      provide: SqsMessageAdapter,
      useFactory: (client: SQSClient) => new SqsMessageAdapter(client),
      inject: [SQS_CLIENT],
    },
    {
      provide: MikroOrmOutboxPublisherRepository,
      useFactory: (entityManager: EntityManager) =>
        new MikroOrmOutboxPublisherRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: OutboxPublisher,
      useFactory: (
        repository: MikroOrmOutboxPublisherRepository,
        sqs: SqsMessageAdapter,
      ) => new OutboxPublisher(repository, sqs, env.LOCALSTACK_QUEUE_NAME),
      inject: [MikroOrmOutboxPublisherRepository, SqsMessageAdapter],
    },
    OutboxPublisherWorker,
  ],
})
export class MessagingModule {}
