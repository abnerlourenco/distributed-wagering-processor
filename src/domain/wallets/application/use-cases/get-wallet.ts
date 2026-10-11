import { WalletNotFoundError } from '../errors/wallet-not-found-error.js';
import type { WalletsRepository } from '../repositories/wallets-repository.js';

export class GetWalletUseCase {
  constructor(private readonly walletsRepository: WalletsRepository) {}

  async execute(walletId: string) {
    const wallet = await this.walletsRepository.findById(walletId);

    if (!wallet) {
      throw new WalletNotFoundError();
    }

    return { wallet };
  }
}
