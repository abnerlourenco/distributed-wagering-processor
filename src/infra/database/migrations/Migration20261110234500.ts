import { Migration } from '@mikro-orm/migrations';

export class Migration20261110234500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "outbox_messages"
        drop constraint "outbox_messages_status_valid";
      alter table "outbox_messages"
        add constraint "outbox_messages_status_valid"
        check ("status" in ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD'));
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      update "outbox_messages"
      set "status" = 'FAILED'
      where "status" = 'DEAD';

      alter table "outbox_messages"
        drop constraint "outbox_messages_status_valid";
      alter table "outbox_messages"
        add constraint "outbox_messages_status_valid"
        check ("status" in ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'));
    `);
  }
}
