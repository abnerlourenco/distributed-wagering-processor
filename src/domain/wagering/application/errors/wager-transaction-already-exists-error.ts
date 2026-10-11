import { DomainError } from '../../../../core/domain/domain-error.js';

export class WagerTransactionAlreadyExistsError extends DomainError {
  constructor() {
    super('Wager transaction already exists for this provider and external transaction id');
    this.name = 'WagerTransactionAlreadyExistsError';
  }
}
