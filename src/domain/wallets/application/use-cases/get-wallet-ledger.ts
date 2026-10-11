import { WalletNotFoundError } from '../errors/wallet-not-found-error.js';
import type { WalletLedgerEntriesRepository } from '../repositories/wallet-ledger-entries-repository.js';
import type { WalletsRepository } from '../repositories/wallets-repository.js';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.js';

export const DEFAULT_WALLET_LEDGER_PAGE_SIZE = 50;
export const MAX_WALLET_LEDGER_PAGE_SIZE = 100;

export class GetWalletLedgerUseCase {
  constructor(
    private readonly walletsRepository: WalletsRepository,
    private readonly ledgerRepository: WalletLedgerEntriesRepository,
  ) {}

  async execute(input: {
    walletId: string;
    cursor?: string;
    limit?: number;
  }) {
    const limit = input.limit ?? DEFAULT_WALLET_LEDGER_PAGE_SIZE;
    const before = input.cursor
      ? decodeLedgerCursor(input.cursor, input.walletId)
      : undefined;
    const wallet = await this.walletsRepository.findById(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError();
    }

    const page = await this.ledgerRepository.findPage(
      input.walletId,
      limit + 1,
      before,
    );
    const hasMore = page.length > limit;
    const items = hasMore ? page.slice(0, limit) : page;
    const lastItem = items.at(-1);

    return {
      entries: items.map(({ entry }) => entry),
      nextCursor:
        hasMore && lastItem
          ? encodeLedgerCursor(input.walletId, {
              createdAt: lastItem.cursorCreatedAt,
              id: lastItem.entry.id,
            })
          : null,
    };
  }
}
