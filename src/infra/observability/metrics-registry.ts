import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const WAGER_STATUSES = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;

@Injectable()
export class MetricsRegistry {
  readonly registry = new Registry();
  readonly transactionsByStatus: Gauge<'status'>;
  readonly duplicates: Counter<'source'>;
  readonly retries: Counter<'stage'>;
  readonly deadLetterMessages: Gauge<'queue'>;
  readonly lockConflicts: Counter;
  readonly outboxLagSeconds: Gauge;
  readonly processingDurationSeconds: Histogram;

  constructor() {
    this.registry.setDefaultLabels({
      service: 'distributed-wagering-processor',
    });
    collectDefaultMetrics({ register: this.registry });

    this.transactionsByStatus = new Gauge({
      name: 'wager_transactions',
      help: 'Persisted wager transactions grouped by current status.',
      labelNames: ['status'],
      registers: [this.registry],
    });
    this.duplicates = new Counter({
      name: 'wagering_duplicates_total',
      help: 'Idempotent duplicate requests or messages detected.',
      labelNames: ['source'],
      registers: [this.registry],
    });
    this.retries = new Counter({
      name: 'wagering_retries_total',
      help: 'Retry attempts scheduled by processing stage.',
      labelNames: ['stage'],
      registers: [this.registry],
    });
    this.deadLetterMessages = new Gauge({
      name: 'wagering_dlq_messages',
      help: 'Messages visible or in flight in the configured SQS dead-letter queue.',
      labelNames: ['queue'],
      registers: [this.registry],
    });
    this.lockConflicts = new Counter({
      name: 'wagering_lock_conflicts_total',
      help: 'PostgreSQL deadlock, lock-not-available, or serialization conflicts.',
      registers: [this.registry],
    });
    this.outboxLagSeconds = new Gauge({
      name: 'wagering_outbox_lag_seconds',
      help: 'Age of the oldest available wager command waiting in the Outbox.',
      registers: [this.registry],
    });
    this.processingDurationSeconds = new Histogram({
      name: 'wagering_transaction_processing_duration_seconds',
      help: 'Time spent processing a wager command.',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
  }
}
