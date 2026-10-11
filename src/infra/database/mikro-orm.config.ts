import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { resolvedDatabaseUrl } from '../env.js';
import { WalletEntity } from './mikro-orm/entities/wallet.entity.js';
import { WagerTransactionEntity } from './mikro-orm/entities/wager-transaction.entity.js';

export const mikroOrmConfig = defineConfig({
  clientUrl: resolvedDatabaseUrl,
  extensions: [Migrator],
  entities: [WalletEntity, WagerTransactionEntity],
  metadataProvider: ReflectMetadataProvider,
  preferTs: false,
  migrations: {
    path: 'dist/infra/database/migrations',
    pathTs: 'src/infra/database/migrations',
  },
});

export default mikroOrmConfig;
