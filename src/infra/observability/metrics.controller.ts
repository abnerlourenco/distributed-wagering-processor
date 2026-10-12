import { Controller, Get, Header } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { env } from '../env.js';
import { SqsMessageAdapter } from '../messaging/sqs/sqs-message-adapter.js';
import { MetricsRegistry, WAGER_STATUSES } from './metrics-registry.js';

@Controller()
export class MetricsController {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly sqs: SqsMessageAdapter,
    private readonly metrics: MetricsRegistry,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    await this.refreshTransactionMetrics();
    await this.refreshOutboxMetrics();
    await this.refreshDeadLetterQueueMetric();
    return this.metrics.registry.metrics();
  }

  private async refreshTransactionMetrics(): Promise<void> {
    const rows = await this.entityManager
      .getConnection()
      .execute<Array<{ status: string; count: string }>>(
        'select "status", count(*)::text as "count" from "wager_transactions" group by "status"',
      );
    const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));

    for (const status of WAGER_STATUSES) {
      this.metrics.transactionsByStatus.set(
        { status },
        counts.get(status) ?? 0,
      );
    }
  }

  private async refreshOutboxMetrics(): Promise<void> {
    const rows = await this.entityManager
      .getConnection()
      .execute<Array<{ lag_seconds: string | null }>>(
        `
          select extract(epoch from current_timestamp - min("occurred_at"))::text
            as "lag_seconds"
          from "outbox_messages"
          where "event_type" = 'WagerTransactionRequested'
            and "status" in ('PENDING', 'FAILED', 'PROCESSING')
        `,
      );
    this.metrics.outboxLagSeconds.set(Number(rows[0]?.lag_seconds ?? 0));
  }

  private async refreshDeadLetterQueueMetric(): Promise<void> {
    const depth = await this.sqs.getApproximateQueueDepth(
      env.LOCALSTACK_COMMAND_DLQ_QUEUE_NAME,
    );
    this.metrics.deadLetterMessages.set(
      { queue: env.LOCALSTACK_COMMAND_DLQ_QUEUE_NAME },
      depth,
    );
  }
}
