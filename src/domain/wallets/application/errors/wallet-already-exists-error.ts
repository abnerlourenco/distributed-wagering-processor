import { DomainError } from '../../../../core/domain/domain-error.js';

export class WalletAlreadyExistsError extends DomainError {
  constructor() {
    super('A wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}
