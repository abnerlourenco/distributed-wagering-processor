export const MAX_PENDING_REFERENCE_ATTEMPTS = 10;
export const PENDING_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_REFERENCE_BASE_DELAY_MS = 1000;
export const PENDING_REFERENCE_MAX_DELAY_MS = 5 * 60 * 1000;

export function getPendingReferenceRetryAt(now: Date, attempt: number): Date {
  const delayMs = Math.min(
    PENDING_REFERENCE_MAX_DELAY_MS,
    PENDING_REFERENCE_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  );
  return new Date(now.getTime() + delayMs);
}

export function hasPendingReferenceRetryExpired(
  createdAt: Date,
  now: Date,
): boolean {
  return now.getTime() - createdAt.getTime() >= PENDING_REFERENCE_TTL_MS;
}
