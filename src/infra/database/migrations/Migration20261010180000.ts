import { Migration } from '@mikro-orm/migrations';

export class Migration20261010180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(20, 2) not null default 0.00,
        "version" integer not null default 1,
        "created_at" timestamptz not null default current_timestamp,
        "updated_at" timestamptz not null default current_timestamp,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1),
        constraint "wallets_currency_iso_4217" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_player_id_currency_unique" unique ("player_id", "currency")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "wallets" cascade;');
  }
}
