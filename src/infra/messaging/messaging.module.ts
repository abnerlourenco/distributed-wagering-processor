import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../env.js';
import { MikroOrmOutboxPublisherRepository } from './outbox/mikro-orm-outbox-publisher.repository.js';
import { OutboxPublisher } from './outbox/outbox-publisher.js';
import { OutboxPublisherWorker } from './outbox/outbox-publisher.worker.js';
import { MikroOrmInboxConsumerRepository } from './inbox/mikro-orm-inbox-consumer.repository.js';
import { OutboxEventConsumer } from './inbox/outbox-event-consumer.js';
import { OutboxEventConsumerWorker } from './inbox/outbox-event-consumer.worker.js';
import { SqsMessageAdapter } from './sqs/sqs-message-adapter.js';
import { WageringModule } from '../http/wagering/wagering.module.js';
import { WagerCommandConsumer } from './commands/wager-command-consumer.js';
import { WagerCommandConsumerWorker } from './commands/wager-command-consumer.worker.js';
import { ProcessWagerTransactionUseCase } from '../../domain/wagering/application/use-cases/process-wager-transaction.js';

const SQS_CLIENT = Symbol('SQS_CLIENT');

@Module({
  imports: [WageringModule],
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
      ) =>
        new OutboxPublisher(
          repository,
          sqs,
          env.LOCALSTACK_QUEUE_NAME,
          env.LOCALSTACK_COMMAND_QUEUE_NAME,
        ),
      inject: [MikroOrmOutboxPublisherRepository, SqsMessageAdapter],
    },
    OutboxPublisherWorker,
    {
      provide: MikroOrmInboxConsumerRepository,
      useFactory: (entityManager: EntityManager) =>
        new MikroOrmInboxConsumerRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: OutboxEventConsumer,
      useFactory: (
        repository: MikroOrmInboxConsumerRepository,
        sqs: SqsMessageAdapter,
      ) => new OutboxEventConsumer(repository, sqs, env.LOCALSTACK_QUEUE_NAME),
      inject: [MikroOrmInboxConsumerRepository, SqsMessageAdapter],
    },
    OutboxEventConsumerWorker,
    {
      provide: WagerCommandConsumer,
      useFactory: (
        processTransaction: ProcessWagerTransactionUseCase,
        sqs: SqsMessageAdapter,
      ) =>
        new WagerCommandConsumer(
          processTransaction,
          sqs,
          env.LOCALSTACK_COMMAND_QUEUE_NAME,
        ),
      inject: [ProcessWagerTransactionUseCase, SqsMessageAdapter],
    },
    WagerCommandConsumerWorker,
  ],
})
export class MessagingModule {}
