import { DomainError } from '../../../../core/domain/domain-error.js';

export class InsufficientWalletBalanceError extends DomainError {
  constructor() {
    super('Wallet has insufficient balance');
    this.name = 'InsufficientWalletBalanceError';
  }
}
