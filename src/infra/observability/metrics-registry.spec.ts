import { MetricsRegistry } from './metrics-registry.js';

describe('MetricsRegistry', () => {
  it('exposes the required metric families in Prometheus format', async () => {
    const metrics = new MetricsRegistry();
    metrics.transactionsByStatus.set({ status: 'PROCESSED' }, 3);
    metrics.duplicates.labels('sqs').inc();
    metrics.retries.labels('sqs_consumer').inc();
    metrics.deadLetterMessages.labels('wager-transactions-dlq.fifo').set(2);
    metrics.lockConflicts.inc();
    metrics.outboxLagSeconds.set(1.5);
    metrics.processingDurationSeconds.observe(0.25);

    const output = await metrics.registry.metrics();

    expect(output).toMatch(
      /wager_transactions\{[^}]*status="PROCESSED"[^}]*\} 3/,
    );
    expect(output).toMatch(
      /wagering_duplicates_total\{[^}]*source="sqs"[^}]*\} 1/,
    );
    expect(output).toMatch(
      /wagering_retries_total\{[^}]*stage="sqs_consumer"[^}]*\} 1/,
    );
    expect(output).toMatch(
      /wagering_dlq_messages\{[^}]*queue="wager-transactions-dlq\.fifo"[^}]*\} 2/,
    );
    expect(output).toMatch(/wagering_lock_conflicts_total\{[^}]*\} 1/);
    expect(output).toMatch(/wagering_outbox_lag_seconds\{[^}]*\} 1\.5/);
    expect(output).toMatch(
      /wagering_transaction_processing_duration_seconds_count\{[^}]*\} 1/,
    );
  });
});
