import { describe, expect, it } from 'vitest';
import { Wallet } from '../../../domain/wallets/enterprise/entities/wallet.js';
import type { WalletsRepository } from '../../../domain/wallets/application/repositories/wallets-repository.js';
import { OpenWalletUseCase } from '../../../domain/wallets/application/use-cases/open-wallet.js';
import { GetWalletUseCase } from '../../../domain/wallets/application/use-cases/get-wallet.js';
import { GetWalletLedgerUseCase } from '../../../domain/wallets/application/use-cases/get-wallet-ledger.js';
import { WalletsController } from './wallets.controller.js';

class InMemoryWalletsRepository implements WalletsRepository {
  async create(): Promise<void> {}

  async findByPlayerIdAndCurrency(): Promise<Wallet | null> {
    return null;
  }

  async findById(): Promise<Wallet | null> {
    return null;
  }
}

describe('WalletsController', () => {
  it('accepts and returns an exact initial balance', async () => {
    const controller = new WalletsController(
      new OpenWalletUseCase(new InMemoryWalletsRepository()),
      new GetWalletUseCase(new InMemoryWalletsRepository()),
      new GetWalletLedgerUseCase(
        new InMemoryWalletsRepository(),
        { findPage: async () => [] },
      ),
    );

    const result = await controller.create({
      playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
      initialBalance: { amount: '123.45', currency: 'BRL' },
    });

    expect(result.balance).toEqual({ amount: '123.45', currency: 'BRL' });
    expect(result.version).toBe(1);
  });

  it('rejects malformed monetary input', async () => {
    const controller = new WalletsController(
      new OpenWalletUseCase(new InMemoryWalletsRepository()),
      new GetWalletUseCase(new InMemoryWalletsRepository()),
      new GetWalletLedgerUseCase(
        new InMemoryWalletsRepository(),
        { findPage: async () => [] },
      ),
    );

    await expect(
      controller.create({
        playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
        initialBalance: { amount: '123.456', currency: 'BRL' },
      }),
    ).rejects.toThrow();
  });
});
