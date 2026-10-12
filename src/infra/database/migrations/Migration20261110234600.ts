import { Migration } from '@mikro-orm/migrations';

export class Migration20261110234600 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_retry_attempts" integer not null default 0,
        add column "reference_next_attempt_at" timestamptz null;

      update "wager_transactions"
      set "reference_next_attempt_at" = current_timestamp
      where "status" = 'PENDING_REFERENCE';

      alter table "wager_transactions"
        add constraint "wager_transactions_reference_retry_attempts_non_negative"
          check ("reference_retry_attempts" >= 0),
        add constraint "wager_transactions_pending_reference_schedule_consistent"
          check (
            ("status" = 'PENDING_REFERENCE') =
            ("reference_next_attempt_at" is not null)
          );

      create index "wager_transactions_pending_reference_ready_index"
        on "wager_transactions" ("reference_next_attempt_at", "id")
        where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists "wager_transactions_pending_reference_ready_index";
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_pending_reference_schedule_consistent",
        drop constraint if exists "wager_transactions_reference_retry_attempts_non_negative",
        drop column if exists "reference_next_attempt_at",
        drop column if exists "reference_retry_attempts";
    `);
  }
}
