import { WalletNotFoundError } from '../errors/wallet-not-found-error.js';
import type { WalletReconciliationRepository } from '../repositories/wallet-reconciliation-repository.js';

export class ReconcileWalletUseCase {
  constructor(
    private readonly reconciliationRepository: WalletReconciliationRepository,
  ) {}

  async execute(walletId: string) {
    const reconciliation =
      await this.reconciliationRepository.reconcile(walletId);
    if (!reconciliation) {
      throw new WalletNotFoundError();
    }

    const difference = reconciliation.calculatedBalance.subtract(
      reconciliation.storedBalance,
    );

    return {
      walletId,
      ...reconciliation,
      difference,
      consistent: difference.isZero(),
    };
  }
}
