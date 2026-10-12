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
import { MikroOrmPendingReferenceRetriesRepository } from '../database/mikro-orm/repositories/mikro-orm-pending-reference-retries.repository.js';
import { PendingReferenceRetryWorker } from './references/pending-reference-retry.worker.js';
import { MetricsRegistry } from '../observability/metrics-registry.js';

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
        metrics: MetricsRegistry,
      ) =>
        new OutboxPublisher(
          repository,
          sqs,
          env.LOCALSTACK_QUEUE_NAME,
          env.LOCALSTACK_COMMAND_QUEUE_NAME,
          env.OUTBOX_MAX_ATTEMPTS,
          metrics,
        ),
      inject: [
        MikroOrmOutboxPublisherRepository,
        SqsMessageAdapter,
        MetricsRegistry,
      ],
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
      provide: MikroOrmPendingReferenceRetriesRepository,
      useFactory: (entityManager: EntityManager) =>
        new MikroOrmPendingReferenceRetriesRepository(entityManager),
      inject: [EntityManager],
    },
    PendingReferenceRetryWorker,
    {
      provide: WagerCommandConsumer,
      useFactory: (
        processTransaction: ProcessWagerTransactionUseCase,
        inbox: MikroOrmInboxConsumerRepository,
        sqs: SqsMessageAdapter,
        metrics: MetricsRegistry,
      ) =>
        new WagerCommandConsumer(
          processTransaction,
          inbox,
          sqs,
          env.LOCALSTACK_COMMAND_QUEUE_NAME,
          10,
          metrics,
        ),
      inject: [
        ProcessWagerTransactionUseCase,
        MikroOrmInboxConsumerRepository,
        SqsMessageAdapter,
        MetricsRegistry,
      ],
    },
    WagerCommandConsumerWorker,
  ],
  exports: [SqsMessageAdapter],
})
export class MessagingModule {}
