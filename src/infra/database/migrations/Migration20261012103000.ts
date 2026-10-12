import { Migration } from '@mikro-orm/migrations';

export class Migration20261012103000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create unique index if not exists "wager_transactions_rollback_reference_unique"
        on "wager_transactions" ("reference_transaction_id")
        where "kind" = 'ROLLBACK'
          and "status" = 'PROCESSED'
          and "reference_transaction_id" is not null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists "wager_transactions_rollback_reference_unique";
    `);
  }
}
