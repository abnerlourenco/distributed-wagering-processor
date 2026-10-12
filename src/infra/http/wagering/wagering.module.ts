import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/process-wager-transaction.js';
import { QueueWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/queue-wager-transaction.js';
import { GetWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/get-wager-transaction.js';
import type { WagerTransactionQueriesRepository } from '../../../domain/wagering/application/repositories/wager-transaction-queries-repository.js';
import { MikroOrmWagerTransactionsRepository } from '../../database/mikro-orm/repositories/mikro-orm-wager-transactions.repository.js';
import { MikroOrmProcessWagerTransactionsRepository } from '../../database/mikro-orm/repositories/mikro-orm-process-wager-transactions.repository.js';
import { MikroOrmQueueWagerTransactionsRepository } from '../../database/mikro-orm/repositories/mikro-orm-queue-wager-transactions.repository.js';
import { WageringTransactionsController } from '../controllers/wagering-transactions.controller.js';
import { WagerTransactionQueriesController } from '../controllers/wager-transaction-queries.controller.js';

const PROCESS_WAGER_TRANSACTIONS_REPOSITORY = Symbol(
  'PROCESS_WAGER_TRANSACTIONS_REPOSITORY',
);
const QUEUE_WAGER_TRANSACTIONS_REPOSITORY = Symbol(
  'QUEUE_WAGER_TRANSACTIONS_REPOSITORY',
);
const WAGER_TRANSACTIONS_REPOSITORY = Symbol('WAGER_TRANSACTIONS_REPOSITORY');

@Module({
  controllers: [
    WageringTransactionsController,
    WagerTransactionQueriesController,
  ],
  providers: [
    {
      provide: PROCESS_WAGER_TRANSACTIONS_REPOSITORY,
      useFactory: (entityManager: EntityManager) =>
        new MikroOrmProcessWagerTransactionsRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: QUEUE_WAGER_TRANSACTIONS_REPOSITORY,
      useFactory: (entityManager: EntityManager) =>
        new MikroOrmQueueWagerTransactionsRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: WAGER_TRANSACTIONS_REPOSITORY,
      useFactory: (
        entityManager: EntityManager,
      ): WagerTransactionQueriesRepository =>
        new MikroOrmWagerTransactionsRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (repository: MikroOrmProcessWagerTransactionsRepository) =>
        new ProcessWagerTransactionUseCase(repository),
      inject: [PROCESS_WAGER_TRANSACTIONS_REPOSITORY],
    },
    {
      provide: QueueWagerTransactionUseCase,
      useFactory: (repository: MikroOrmQueueWagerTransactionsRepository) =>
        new QueueWagerTransactionUseCase(repository),
      inject: [QUEUE_WAGER_TRANSACTIONS_REPOSITORY],
    },
    {
      provide: GetWagerTransactionUseCase,
      useFactory: (repository: WagerTransactionQueriesRepository) =>
        new GetWagerTransactionUseCase(repository),
      inject: [WAGER_TRANSACTIONS_REPOSITORY],
    },
  ],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
