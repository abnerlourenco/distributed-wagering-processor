import { DomainError } from '../../../../core/domain/domain-error.js';

export class WalletNotFoundError extends DomainError {
  constructor() {
    super('Wallet not found');
    this.name = 'WalletNotFoundError';
  }
}
