import { createHash } from 'node:crypto';
import { Money } from '../../../../core/domain/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../enterprise/entities/wallet-ledger-entry.js';
import { Wallet } from '../../enterprise/entities/wallet.js';
import { WalletAlreadyExistsError } from '../errors/wallet-already-exists-error.js';
import type { WalletsRepository } from '../repositories/wallets-repository.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../wagering/enterprise/entities/wager-transaction.js';

export interface OpenWalletRequest {
  playerId: string;
  initialBalance: Money;
}

export interface OpenWalletResponse {
  wallet: Wallet;
}

export class OpenWalletUseCase {
  constructor(private readonly walletsRepository: WalletsRepository) {}

  async execute(request: OpenWalletRequest): Promise<OpenWalletResponse> {
    const existingWallet =
      await this.walletsRepository.findByPlayerIdAndCurrency(
        request.playerId,
        request.initialBalance.currency,
      );

    if (existingWallet) {
      throw new WalletAlreadyExistsError();
    }

    const wallet = Wallet.open(request);

    if (request.initialBalance.isPositive()) {
      const openingTransaction = WagerTransaction.create({
        providerId: 'internal',
        externalTransactionId: `wallet-opening:${wallet.id}`,
        idempotencyKey: `wallet-opening:${wallet.id}`,
        payloadHash: createHash('sha256')
          .update(
            JSON.stringify({
              walletId: wallet.id,
              initialBalance: request.initialBalance.toJSON(),
            }),
          )
          .digest('hex'),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'wallet-opening',
        gameId: 'internal',
        kind: WagerTransactionKind.Opening,
        money: request.initialBalance,
      });
      openingTransaction.markProcessed(undefined, openingTransaction.createdAt);

      const ledgerEntry = WalletLedgerEntry.create({
        walletId: wallet.id,
        transactionId: openingTransaction.id,
        direction: LedgerDirection.Credit,
        money: request.initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: request.initialBalance,
        createdAt: openingTransaction.createdAt,
      });

      await this.walletsRepository.create(wallet, {
        transaction: openingTransaction,
        ledgerEntry,
      });
    } else {
      await this.walletsRepository.create(wallet);
    }

    return { wallet };
  }
}
