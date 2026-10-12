import { DomainError } from '../../../../core/domain/domain-error.js';

export class WagerTransactionNotFoundError extends DomainError {
  constructor() {
    super('Wager transaction not found');
    this.name = 'WagerTransactionNotFoundError';
  }
}
