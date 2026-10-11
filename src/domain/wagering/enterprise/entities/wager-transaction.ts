import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../../core/domain/domain-error.js';
import { Money } from '../../../../core/domain/money.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState
  extends Omit<CreateWagerTransactionProps, 'createdAt' | 'kind'> {
  id: string;
  kind: WagerTransactionKind;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: string,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertRequired('providerId', props.providerId);
    WagerTransaction.assertRequired('externalTransactionId', props.externalTransactionId);
    WagerTransaction.assertRequired('idempotencyKey', props.idempotencyKey);
    WagerTransaction.assertRequired('payloadHash', props.payloadHash);
    WagerTransaction.assertRequired('walletId', props.walletId);
    WagerTransaction.assertRequired('playerId', props.playerId);
    WagerTransaction.assertRequired('roundId', props.roundId);
    WagerTransaction.assertRequired('gameId', props.gameId);

    if (!props.money.isPositive()) {
      throw new DomainError('Wager transaction amount must be positive');
    }

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId?.trim()
    ) {
      throw new DomainError(`${props.kind} requires a referenced external transaction id`);
    }

    if (
      props.referenceExternalTransactionId !== undefined &&
      !props.referenceExternalTransactionId.trim()
    ) {
      throw new DomainError('Referenced external transaction id cannot be empty');
    }

    return new WagerTransaction(
      props.id ?? randomUUID(),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertPending();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertPending();
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(failureCode: string): void {
    this.markTerminal(WagerTransactionStatus.Rejected, failureCode);
  }

  fail(failureCode: string): void {
    this.markTerminal(WagerTransactionStatus.Failed, failureCode);
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  private markTerminal(status: WagerTransactionStatus, failureCode: string): void {
    this.assertPending();
    WagerTransaction.assertRequired('failureCode', failureCode);
    this._status = status;
    this._failureCode = failureCode;
  }

  private assertPending(): void {
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new DomainError(`Cannot transition terminal wager transaction from ${this._status}`);
    }
  }

  private static assertRequired(field: string, value: string): void {
    if (!value.trim()) {
      throw new DomainError(`Wager transaction ${field} is required`);
    }
  }
}
