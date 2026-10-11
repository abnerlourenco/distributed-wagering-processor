import { OpenWalletUseCase } from '../use-cases/open-wallet.js';
import type { WalletsRepository } from '../repositories/wallets-repository.js';

export function makeOpenWalletUseCase(walletsRepository: WalletsRepository): OpenWalletUseCase {
  return new OpenWalletUseCase(walletsRepository);
}
