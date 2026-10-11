import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'consumer_name', length: 128 })
  consumerName!: string;

  @Property({ length: 128 })
  source!: string;

  @Property({ fieldName: 'message_id', length: 255 })
  messageId!: string;

  @Property({ fieldName: 'message_type', length: 255 })
  messageType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'payload_hash', length: 128 })
  payloadHash!: string;

  @Property({ default: 'RECEIVED', length: 16 })
  status!: string;

  @Property({ default: 0 })
  attempts!: number;

  @Property({ defaultRaw: 'current_timestamp', fieldName: 'available_at' })
  availableAt!: Date;

  @Property({ fieldName: 'locked_at', nullable: true })
  lockedAt?: Date;

  @Property({ defaultRaw: 'current_timestamp', fieldName: 'received_at' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', nullable: true })
  processedAt?: Date;

  @Property({ fieldName: 'last_error_code', length: 128, nullable: true })
  lastErrorCode?: string;
}
