
import { Migration } from '@mikro-orm/migrations';

export class Migration20261012110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function "prevent_wallet_ledger_entry_mutation"()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'wallet_ledger_entries_are_immutable'
          using errcode = '55000';
      end;
      $$;

      create trigger "wallet_ledger_entries_immutable"
      before update or delete on "wallet_ledger_entries"
      for each row
      execute function "prevent_wallet_ledger_entry_mutation"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger if exists "wallet_ledger_entries_immutable"
        on "wallet_ledger_entries";

      drop function if exists "prevent_wallet_ledger_entry_mutation"();
    `);
  }
}
