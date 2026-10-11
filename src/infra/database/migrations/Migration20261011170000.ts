import { Migration } from '@mikro-orm/migrations';

export class Migration20261011170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(255) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" varchar(128) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(255) not null,
        "game_id" varchar(255) not null,
        "kind" varchar(16) not null,
        "amount" numeric(20, 2) not null,
        "currency" varchar(3) not null,
        "reference_external_transaction_id" varchar(255) null,
        "reference_transaction_id" uuid null,
        "status" varchar(24) not null,
        "failure_code" varchar(64) null,
        "created_at" timestamptz not null default current_timestamp,
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on update cascade on delete restrict,
        constraint "wager_transactions_provider_id_not_empty" check (length(trim("provider_id")) > 0),
        constraint "wager_transactions_external_id_not_empty" check (length(trim("external_transaction_id")) > 0),
        constraint "wager_transactions_idempotency_key_not_empty" check (length(trim("idempotency_key")) > 0),
        constraint "wager_transactions_payload_hash_not_empty" check (length(trim("payload_hash")) > 0),
        constraint "wager_transactions_round_id_not_empty" check (length(trim("round_id")) > 0),
        constraint "wager_transactions_game_id_not_empty" check (length(trim("game_id")) > 0),
        constraint "wager_transactions_kind_valid" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_valid" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_positive" check ("amount" > 0),
        constraint "wager_transactions_currency_iso_4217" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_reference_required" check ("kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null),
        constraint "wager_transactions_processed_at_consistent" check (("status" = 'PROCESSED') = ("processed_at" is not null)),
        constraint "wager_transactions_provider_external_id_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_provider_idempotency_key_unique" unique ("provider_id", "idempotency_key")
      );

      create index "wager_transactions_wallet_created_at_index" on "wager_transactions" ("wallet_id", "created_at", "id");
      create index "wager_transactions_status_created_at_index" on "wager_transactions" ("status", "created_at");
      create index "wager_transactions_provider_reference_external_id_index" on "wager_transactions" ("provider_id", "reference_external_transaction_id");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "wager_transactions" cascade;');
  }
}
