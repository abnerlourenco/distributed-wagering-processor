import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ length: 6 })
  direction!: string;

  @Property({ precision: 20, scale: 2, type: 'decimal' })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_before', precision: 20, scale: 2, type: 'decimal' })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_after', precision: 20, scale: 2, type: 'decimal' })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at' })
  createdAt!: Date;
}
