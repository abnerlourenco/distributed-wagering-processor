import { describe, expect, it } from 'vitest';
import {
  getPendingReferenceRetryAt,
  hasPendingReferenceRetryExpired,
  MAX_PENDING_REFERENCE_ATTEMPTS,
  PENDING_REFERENCE_MAX_DELAY_MS,
  PENDING_REFERENCE_TTL_MS,
} from './pending-reference-retry-policy.js';

describe('pending reference retry policy', () => {
  it('applies exponential delay capped at five minutes', () => {
    const now = new Date('2026-10-12T00:00:00.000Z');

    expect(getPendingReferenceRetryAt(now, 1).getTime() - now.getTime()).toBe(
      1000,
    );
    expect(getPendingReferenceRetryAt(now, 2).getTime() - now.getTime()).toBe(
      2000,
    );
    expect(getPendingReferenceRetryAt(now, 20).getTime() - now.getTime()).toBe(
      PENDING_REFERENCE_MAX_DELAY_MS,
    );
  });

  it('expires after 24 hours and caps retries at ten attempts', () => {
    const createdAt = new Date('2026-10-12T00:00:00.000Z');
    const expiresAt = new Date(createdAt.getTime() + PENDING_REFERENCE_TTL_MS);

    expect(MAX_PENDING_REFERENCE_ATTEMPTS).toBe(10);
    expect(hasPendingReferenceRetryExpired(createdAt, expiresAt)).toBe(true);
    expect(
      hasPendingReferenceRetryExpired(
        createdAt,
        new Date(expiresAt.getTime() - 1),
      ),
    ).toBe(false);
  });
});
