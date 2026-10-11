import type { WalletLedgerEntry } from '../../enterprise/entities/wallet-ledger-entry.js';

export interface WalletLedgerCursorPosition {
  createdAt: string;
  id: string;
}

export interface WalletLedgerEntryPageItem {
  entry: WalletLedgerEntry;
  cursorCreatedAt: string;
}

export interface WalletLedgerEntriesRepository {
  findPage(
    walletId: string,
    limit: number,
    before?: WalletLedgerCursorPosition,
  ): Promise<WalletLedgerEntryPageItem[]>;
}
