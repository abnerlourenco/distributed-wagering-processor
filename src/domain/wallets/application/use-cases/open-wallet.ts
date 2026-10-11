import { Wallet } from '../../enterprise/entities/wallet.js';
import { WalletAlreadyExistsError } from '../errors/wallet-already-exists-error.js';
import type { WalletsRepository } from '../repositories/wallets-repository.js';

export interface OpenWalletRequest {
  playerId: string;
  currency: string;
}

export interface OpenWalletResponse {
  wallet: Wallet;
}

export class OpenWalletUseCase {
  constructor(private readonly walletsRepository: WalletsRepository) {}

  async execute(request: OpenWalletRequest): Promise<OpenWalletResponse> {
    const existingWallet = await this.walletsRepository.findByPlayerIdAndCurrency(
      request.playerId,
      request.currency,
    );

    if (existingWallet) {
      throw new WalletAlreadyExistsError();
    }

    const wallet = Wallet.open(request);
    await this.walletsRepository.create(wallet);

    return { wallet };
  }
}
