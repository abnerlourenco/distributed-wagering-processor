import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { env } from '../../env.js';
import { SqsMessageAdapter } from '../../messaging/sqs/sqs-message-adapter.js';

type DependencyStatus = 'up' | 'down';

export type ReadinessResult =
  | {
      status: 'ready';
      checks: {
        database: 'up';
        commandQueue: 'up';
        deadLetterQueue: 'up';
      };
    }
  | {
      status: 'not_ready';
      checks: {
        database: DependencyStatus;
        commandQueue: DependencyStatus;
        deadLetterQueue: DependencyStatus;
      };
    };

@Injectable()
export class HealthCheckService {
  private readonly logger = new Logger(HealthCheckService.name);

  constructor(
    private readonly entityManager: EntityManager,
    private readonly sqs: SqsMessageAdapter,
  ) {}

  async checkReadiness(): Promise<ReadinessResult> {
    const [database, commandQueue, deadLetterQueue] = await Promise.all([
      this.checkDatabase(),
      this.checkQueue(env.LOCALSTACK_COMMAND_QUEUE_NAME, 'commandQueue'),
      this.checkQueue(env.LOCALSTACK_COMMAND_DLQ_QUEUE_NAME, 'deadLetterQueue'),
    ]);

    if (
      database === 'up' &&
      commandQueue === 'up' &&
      deadLetterQueue === 'up'
    ) {
      return {
        status: 'ready',
        checks: {
          database: 'up',
          commandQueue: 'up',
          deadLetterQueue: 'up',
        },
      };
    }

    return {
      status: 'not_ready',
      checks: { database, commandQueue, deadLetterQueue },
    };
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      await this.entityManager.getConnection().execute('select 1');
      return 'up';
    } catch (error) {
      this.logProbeFailure('database', error);
      return 'down';
    }
  }

  private async checkQueue(
    queueName: string,
    dependency: 'commandQueue' | 'deadLetterQueue',
  ): Promise<DependencyStatus> {
    try {
      await this.sqs.getQueueUrl(queueName);
      return 'up';
    } catch (error) {
      this.logProbeFailure(dependency, error);
      return 'down';
    }
  }

  private logProbeFailure(dependency: string, error: unknown): void {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    this.logger.error(`Readiness probe failed (${dependency}, ${errorName})`);
  }
}
