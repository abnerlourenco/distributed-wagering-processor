import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/process-wager-transaction.js';
import { MikroOrmProcessWagerTransactionsRepository } from '../../database/mikro-orm/repositories/mikro-orm-process-wager-transactions.repository.js';
import { WageringTransactionsController } from '../controllers/wagering-transactions.controller.js';

const PROCESS_WAGER_TRANSACTIONS_REPOSITORY = Symbol(
  'PROCESS_WAGER_TRANSACTIONS_REPOSITORY',
);

@Module({
  controllers: [WageringTransactionsController],
  providers: [
    {
      provide: PROCESS_WAGER_TRANSACTIONS_REPOSITORY,
      useFactory: (entityManager: EntityManager) =>
        new MikroOrmProcessWagerTransactionsRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (repository: MikroOrmProcessWagerTransactionsRepository) =>
        new ProcessWagerTransactionUseCase(repository),
      inject: [PROCESS_WAGER_TRANSACTIONS_REPOSITORY],
    },
  ],
})
export class WageringModule {}
