import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { resolvedDatabaseUrl } from '../env.js';
import { WalletEntity } from './mikro-orm/entities/wallet.entity.js';
import { WagerTransactionEntity } from './mikro-orm/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from './mikro-orm/entities/wallet-ledger-entry.entity.js';
import { InboxMessageEntity } from './mikro-orm/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from './mikro-orm/entities/outbox-message.entity.js';

export const mikroOrmConfig = defineConfig({
  clientUrl: resolvedDatabaseUrl,
  extensions: [Migrator],
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  metadataProvider: ReflectMetadataProvider,
  preferTs: false,
  migrations: {
    path: 'dist/infra/database/migrations',
    pathTs: 'src/infra/database/migrations',
  },
});

export default mikroOrmConfig;
