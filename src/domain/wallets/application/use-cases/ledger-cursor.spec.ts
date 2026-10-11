import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidLedgerCursorError } from '../errors/invalid-ledger-cursor-error.js';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.js';

describe('ledger cursor', () => {
  it('encodes and decodes an exact keyset position for its wallet', () => {
    const walletId = randomUUID();
    const position = {
      createdAt: '2026-10-11T22:58:28.228123Z',
      id: randomUUID(),
    };
    const cursor = encodeLedgerCursor(walletId, position);

    expect(cursor).not.toBe(
      JSON.stringify({ version: 1, walletId, ...position }),
    );
    expect(decodeLedgerCursor(cursor, walletId)).toEqual(position);
  });

  it('rejects a cursor used for a different wallet', () => {
    const cursor = encodeLedgerCursor(randomUUID(), {
      createdAt: '2026-10-11T22:58:28.228123Z',
      id: randomUUID(),
    });

    expect(() => decodeLedgerCursor(cursor, randomUUID())).toThrow(
      InvalidLedgerCursorError,
    );
  });

  it('rejects malformed cursor values', () => {
    expect(() => decodeLedgerCursor('not-a-cursor', randomUUID())).toThrow(
      InvalidLedgerCursorError,
    );
  });
});
