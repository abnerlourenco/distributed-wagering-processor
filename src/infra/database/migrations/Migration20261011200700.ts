import { Migration } from '@mikro-orm/migrations';

export class Migration20261011200700 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "resulting_balance" numeric(20, 2) null,
        add constraint "wager_transactions_resulting_balance_non_negative"
          check ("resulting_balance" is null or "resulting_balance" >= 0);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_resulting_balance_non_negative",
        drop column "resulting_balance";
    `);
  }
}
