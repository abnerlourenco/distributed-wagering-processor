import { z } from 'zod';
import { InvalidLedgerCursorError } from '../errors/invalid-ledger-cursor-error.js';
import type { WalletLedgerCursorPosition } from '../repositories/wallet-ledger-entries-repository.js';

const cursorPayloadSchema = z
  .object({
    version: z.literal(1),
    walletId: z.uuid(),
    createdAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    id: z.uuid(),
  })
  .strict();

export function encodeLedgerCursor(
  walletId: string,
  position: WalletLedgerCursorPosition,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      walletId,
      createdAt: position.createdAt,
      id: position.id,
    }),
  ).toString('base64url');
}

export function decodeLedgerCursor(
  cursor: string,
  walletId: string,
): WalletLedgerCursorPosition {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    throw new InvalidLedgerCursorError();
  }

  const decoded = Buffer.from(cursor, 'base64url');
  if (decoded.toString('base64url') !== cursor) {
    throw new InvalidLedgerCursorError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new InvalidLedgerCursorError();
  }

  const parsed = cursorPayloadSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.walletId !== walletId ||
    !Number.isFinite(Date.parse(parsed.data.createdAt))
  ) {
    throw new InvalidLedgerCursorError();
  }

  return {
    createdAt: parsed.data.createdAt,
    id: parsed.data.id,
  };
}
