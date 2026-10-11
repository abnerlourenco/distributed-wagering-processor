import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'deduplication_key', length: 255, nullable: true })
  deduplicationKey?: string;

  @Property({ fieldName: 'aggregate_type', length: 128 })
  aggregateType!: string;

  @Property({ fieldName: 'aggregate_id', length: 255 })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', length: 255 })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ default: 'PENDING', length: 16 })
  status!: string;

  @Property({ default: 0 })
  attempts!: number;

  @Property({ defaultRaw: 'current_timestamp', fieldName: 'available_at' })
  availableAt!: Date;

  @Property({ fieldName: 'locked_at', nullable: true })
  lockedAt?: Date;

  @Property({ defaultRaw: 'current_timestamp', fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property({ fieldName: 'published_at', nullable: true })
  publishedAt?: Date;

  @Property({ fieldName: 'last_error_code', length: 128, nullable: true })
  lastErrorCode?: string;
}
