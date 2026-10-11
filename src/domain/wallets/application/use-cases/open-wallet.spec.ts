import { describe, expect, it } from 'vitest';
import { Money } from '../../../../core/domain/money.js';
import type { Wallet } from '../../enterprise/entities/wallet.js';
import type {
  WalletOpeningLedger,
  WalletsRepository,
} from '../repositories/wallets-repository.js';
import { OpenWalletUseCase } from './open-wallet.js';

class InMemoryWalletsRepository implements WalletsRepository {
  private readonly wallets: Wallet[] = [];
  readonly openingLedgers: WalletOpeningLedger[] = [];

  async create(
    wallet: Wallet,
    openingLedger?: WalletOpeningLedger,
  ): Promise<void> {
    this.wallets.push(wallet);

    if (openingLedger) {
      this.openingLedgers.push(openingLedger);
    }
  }

  async findByPlayerIdAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    return (
      this.wallets.find(
        (wallet) =>
          wallet.playerId === playerId && wallet.currency === currency,
      ) ?? null
    );
  }

  async findById(walletId: string): Promise<Wallet | null> {
    return this.wallets.find((wallet) => wallet.id === walletId) ?? null;
  }
}

describe('OpenWalletUseCase', () => {
  it('opens a zero-balance wallet for a player and currency', async () => {
    const repository = new InMemoryWalletsRepository();
    const useCase = new OpenWalletUseCase(repository);

    const { wallet } = await useCase.execute({
      playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
    expect(repository.openingLedgers).toHaveLength(0);
  });

  it('creates a processed opening transaction and credit ledger entry for a positive initial balance', async () => {
    const repository = new InMemoryWalletsRepository();
    const useCase = new OpenWalletUseCase(repository);
    const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });

    const { wallet } = await useCase.execute({
      playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
      initialBalance,
    });
    const [{ transaction, ledgerEntry }] = repository.openingLedgers;

    expect(wallet.balance.equals(initialBalance)).toBe(true);
    expect(wallet.version).toBe(1);
    expect(transaction.kind).toBe('OPENING');
    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.processedAt).toBeDefined();
    expect(ledgerEntry.direction).toBe('CREDIT');
    expect(ledgerEntry.balanceBefore.toString()).toBe('0.00');
    expect(ledgerEntry.balanceAfter.toString()).toBe('100.00');
    expect(ledgerEntry.isBalanced()).toBe(true);
  });

  it('does not open two wallets for the same player and currency', async () => {
    const useCase = new OpenWalletUseCase(new InMemoryWalletsRepository());
    const request = {
      playerId: 'd0c4be2c-e53d-44df-9724-e0d5d5172d0b',
      initialBalance: Money.zero('BRL'),
    };

    await useCase.execute(request);

    await expect(useCase.execute(request)).rejects.toThrow('already exists');
  });
});
