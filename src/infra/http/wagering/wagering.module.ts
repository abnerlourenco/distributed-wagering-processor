import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessBetUseCase } from '../../../domain/wagering/application/use-cases/process-bet.js';
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
      provide: ProcessBetUseCase,
      useFactory: (repository: MikroOrmProcessWagerTransactionsRepository) =>
        new ProcessBetUseCase(repository),
      inject: [PROCESS_WAGER_TRANSACTIONS_REPOSITORY],
    },
  ],
})
export class WageringModule {}
