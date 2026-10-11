import type { Wallet } from '../../enterprise/entities/wallet.js';

export interface WalletsRepository {
  create(wallet: Wallet): Promise<void>;
  findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
}
