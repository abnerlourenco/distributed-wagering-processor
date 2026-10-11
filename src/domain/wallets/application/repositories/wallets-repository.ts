import type { Wallet } from '../../enterprise/entities/wallet.js';
import type { WagerTransaction } from '../../../wagering/enterprise/entities/wager-transaction.js';
import type { WalletLedgerEntry } from '../../enterprise/entities/wallet-ledger-entry.js';

export interface WalletOpeningLedger {
  transaction: WagerTransaction;
  ledgerEntry: WalletLedgerEntry;
}

export interface WalletsRepository {
  create(wallet: Wallet, openingLedger?: WalletOpeningLedger): Promise<void>;
  findByPlayerIdAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;
  findById(walletId: string): Promise<Wallet | null>;
}
