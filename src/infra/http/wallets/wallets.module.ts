import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { makeOpenWalletUseCase } from '../../../domain/wallets/application/factories/make-open-wallet-use-case.js';
import { GetWalletUseCase } from '../../../domain/wallets/application/use-cases/get-wallet.js';
import { GetWalletLedgerUseCase } from '../../../domain/wallets/application/use-cases/get-wallet-ledger.js';
import { OpenWalletUseCase } from '../../../domain/wallets/application/use-cases/open-wallet.js';
import { MikroOrmWalletLedgerEntriesRepository } from '../../database/mikro-orm/repositories/mikro-orm-wallet-ledger-entries.repository.js';
import { MikroOrmWalletsRepository } from '../../database/mikro-orm/repositories/mikro-orm-wallets.repository.js';
import { WalletsController } from '../controllers/wallets.controller.js';

const WALLETS_REPOSITORY = Symbol('WALLETS_REPOSITORY');
const WALLET_LEDGER_ENTRIES_REPOSITORY = Symbol(
  'WALLET_LEDGER_ENTRIES_REPOSITORY',
);

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: WALLETS_REPOSITORY,
      useFactory: (entityManager: EntityManager) => new MikroOrmWalletsRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: WALLET_LEDGER_ENTRIES_REPOSITORY,
      useFactory: (entityManager: EntityManager) =>
        new MikroOrmWalletLedgerEntriesRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: OpenWalletUseCase,
      useFactory: (walletsRepository: MikroOrmWalletsRepository) =>
        makeOpenWalletUseCase(walletsRepository),
      inject: [WALLETS_REPOSITORY],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (walletsRepository: MikroOrmWalletsRepository) =>
        new GetWalletUseCase(walletsRepository),
      inject: [WALLETS_REPOSITORY],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (
        walletsRepository: MikroOrmWalletsRepository,
        ledgerRepository: MikroOrmWalletLedgerEntriesRepository,
      ) => new GetWalletLedgerUseCase(walletsRepository, ledgerRepository),
      inject: [WALLETS_REPOSITORY, WALLET_LEDGER_ENTRIES_REPOSITORY],
    },
  ],
})
export class WalletsModule {}
