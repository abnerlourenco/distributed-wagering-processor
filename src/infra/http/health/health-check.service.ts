import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

export type ReadinessResult =
  | { status: 'ready'; checks: { database: 'up' } }
  | { status: 'not_ready'; checks: { database: 'down' } };

@Injectable()
export class HealthCheckService {
  private readonly logger = new Logger(HealthCheckService.name);

  constructor(private readonly entityManager: EntityManager) {}

  async checkReadiness(): Promise<ReadinessResult> {
    try {
      await this.entityManager.getConnection().execute('select 1');

      return { status: 'ready', checks: { database: 'up' } };
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      this.logger.error(`Database readiness probe failed (${errorName})`);

      return { status: 'not_ready', checks: { database: 'down' } };
    }
  }
}
