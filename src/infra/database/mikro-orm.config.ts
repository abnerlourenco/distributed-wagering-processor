import { defineConfig } from '@mikro-orm/postgresql';
import { resolvedDatabaseUrl } from '../../env.js';

export const mikroOrmConfig = defineConfig({
  clientUrl: resolvedDatabaseUrl,
  entities: [],
  discovery: {
    warnWhenNoEntities: false,
  },
  migrations: {
    path: 'dist/infra/database/migrations',
    pathTs: 'src/infra/database/migrations',
  },
});
