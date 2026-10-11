import { DomainError } from '../../../../core/domain/domain-error.js';

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super('IdempotencyKey was already used with a different payload');
    this.name = 'IdempotencyConflictError';
  }
}
