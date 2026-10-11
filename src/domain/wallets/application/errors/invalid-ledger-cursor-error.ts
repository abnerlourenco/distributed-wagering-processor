import { DomainError } from '../../../../core/domain/domain-error.js';

export class InvalidLedgerCursorError extends DomainError {
  constructor() {
    super('Invalid ledger cursor');
    this.name = 'InvalidLedgerCursorError';
  }
}
