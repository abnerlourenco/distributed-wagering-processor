import { Migration } from '@mikro-orm/migrations';

export class Migration20261011180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wallets"
        add constraint "wallets_id_currency_unique" unique ("id", "currency");

      alter table "wager_transactions"
        add constraint "wager_transactions_id_wallet_currency_unique"
        unique ("id", "wallet_id", "currency");

      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(6) not null,
        "amount" numeric(20, 2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(20, 2) not null,
        "balance_after" numeric(20, 2) not null,
        "created_at" timestamptz not null default current_timestamp,
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_currency_foreign"
          foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency")
          on update cascade on delete restrict,
        constraint "wallet_ledger_entries_transaction_wallet_currency_foreign"
          foreign key ("transaction_id", "wallet_id", "currency")
          references "wager_transactions" ("id", "wallet_id", "currency")
          on update cascade on delete restrict,
        constraint "wallet_ledger_entries_direction_valid"
          check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_amount_positive"
          check ("amount" > 0),
        constraint "wallet_ledger_entries_currency_iso_4217"
          check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_entries_balances_non_negative"
          check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_entries_balance_consistent"
          check (
            ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
            or
            ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
          ),
        constraint "wallet_ledger_entries_transaction_wallet_unique"
          unique ("transaction_id", "wallet_id")
      );

      create index "wallet_ledger_entries_wallet_created_at_index"
        on "wallet_ledger_entries" ("wallet_id", "created_at", "id");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table if exists "wallet_ledger_entries";
      alter table "wager_transactions"
        drop constraint "wager_transactions_id_wallet_currency_unique";
      alter table "wallets"
        drop constraint "wallets_id_currency_unique";
    `);
  }
}
