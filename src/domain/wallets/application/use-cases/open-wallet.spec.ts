import { describe, expect, it } from 'vitest';
import type { Wallet } from '../../enterprise/entities/wallet.js';
import type { WalletsRepository } from '../repositories/wallets-repository.js';
import { OpenWalletUseCase } from './open-wallet.js';

class InMemoryWalletsRepository implements WalletsRepository {
  private readonly wallets: Wallet[] = [];

  async create(wallet: Wallet): Promise<void> {
    this.wallets.push(wallet);
  }

  async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return (
      this.wallets.find(
        (wallet) => wallet.playerId === playerId && wallet.currency === currency,
      ) ?? null
    );
  }
}

describe('OpenWalletUseCase', () => {
  it('opens a zero-balance wallet for a player and currency', async () => {
    const useCase = new OpenWalletUseCase(new InMemoryWalletsRepository());

    const { wallet } = await useCase.execute({
      playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
      currency: 'BRL',
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });

  it('does not open two wallets for the same player and currency', async () => {
    const useCase = new OpenWalletUseCase(new InMemoryWalletsRepository());
    const request = {
      playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
      currency: 'BRL',
    };

    await useCase.execute(request);

    await expect(useCase.execute(request)).rejects.toThrow('already exists');
  });
});
