import { Migration } from '@mikro-orm/migrations';

export class Migration20261011200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "inbox_messages" (
        "id" uuid not null,
        "consumer_name" varchar(128) not null,
        "source" varchar(128) not null,
        "message_id" varchar(255) not null,
        "message_type" varchar(255) not null,
        "payload" jsonb not null,
        "payload_hash" varchar(128) not null,
        "status" varchar(16) not null default 'RECEIVED',
        "attempts" integer not null default 0,
        "available_at" timestamptz not null default current_timestamp,
        "locked_at" timestamptz null,
        "received_at" timestamptz not null default current_timestamp,
        "processed_at" timestamptz null,
        "last_error_code" varchar(128) null,
        constraint "inbox_messages_pkey" primary key ("id"),
        constraint "inbox_messages_consumer_source_message_unique"
          unique ("consumer_name", "source", "message_id"),
        constraint "inbox_messages_consumer_not_empty"
          check (length(trim("consumer_name")) > 0),
        constraint "inbox_messages_source_not_empty"
          check (length(trim("source")) > 0),
        constraint "inbox_messages_message_id_not_empty"
          check (length(trim("message_id")) > 0),
        constraint "inbox_messages_message_type_not_empty"
          check (length(trim("message_type")) > 0),
        constraint "inbox_messages_payload_hash_not_empty"
          check (length(trim("payload_hash")) > 0),
        constraint "inbox_messages_status_valid"
          check ("status" in ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')),
        constraint "inbox_messages_attempts_non_negative"
          check ("attempts" >= 0),
        constraint "inbox_messages_processed_at_consistent"
          check (("status" = 'PROCESSED') = ("processed_at" is not null))
      );

      create index "inbox_messages_ready_index"
        on "inbox_messages" ("available_at", "received_at", "id")
        where "status" in ('RECEIVED', 'FAILED');

      create table "outbox_messages" (
        "id" uuid not null,
        "deduplication_key" varchar(255) null,
        "aggregate_type" varchar(128) not null,
        "aggregate_id" varchar(255) not null,
        "event_type" varchar(255) not null,
        "payload" jsonb not null,
        "status" varchar(16) not null default 'PENDING',
        "attempts" integer not null default 0,
        "available_at" timestamptz not null default current_timestamp,
        "locked_at" timestamptz null,
        "occurred_at" timestamptz not null default current_timestamp,
        "published_at" timestamptz null,
        "last_error_code" varchar(128) null,
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_deduplication_key_unique"
          unique ("deduplication_key"),
        constraint "outbox_messages_aggregate_type_not_empty"
          check (length(trim("aggregate_type")) > 0),
        constraint "outbox_messages_aggregate_id_not_empty"
          check (length(trim("aggregate_id")) > 0),
        constraint "outbox_messages_event_type_not_empty"
          check (length(trim("event_type")) > 0),
        constraint "outbox_messages_status_valid"
          check ("status" in ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')),
        constraint "outbox_messages_attempts_non_negative"
          check ("attempts" >= 0),
        constraint "outbox_messages_published_at_consistent"
          check (("status" = 'PUBLISHED') = ("published_at" is not null))
      );

      create index "outbox_messages_ready_index"
        on "outbox_messages" ("available_at", "occurred_at", "id")
        where "status" in ('PENDING', 'FAILED');
      create index "outbox_messages_aggregate_index"
        on "outbox_messages" ("aggregate_type", "aggregate_id", "occurred_at");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table if exists "outbox_messages";
      drop table if exists "inbox_messages";
    `);
  }
}