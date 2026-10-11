import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', length: 255 })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', length: 255 })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', length: 255 })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', length: 128 })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ fieldName: 'round_id', length: 255 })
  roundId!: string;

  @Property({ fieldName: 'game_id', length: 255 })
  gameId!: string;

  @Property({ length: 16 })
  kind!: string;

  @Property({ precision: 20, scale: 2, type: 'decimal' })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ fieldName: 'reference_external_transaction_id', length: 255, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ length: 24 })
  status!: string;

  @Property({ fieldName: 'failure_code', length: 64, nullable: true })
  failureCode?: string;

  @Property({ fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ fieldName: 'processed_at', nullable: true })
  processedAt?: Date;
}
