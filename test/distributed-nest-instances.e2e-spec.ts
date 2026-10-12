
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const APP_URLS = [
  process.env.E2E_APP1_URL ?? 'http://localhost:3001',
  process.env.E2E_APP2_URL ?? 'http://localhost:3002',
  process.env.E2E_APP3_URL ?? 'http://localhost:3003',
];

const PROVIDER_ID = 'provider-distributed-e2e';
const CURRENCY = 'BRL';

type WalletResponse = {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
};

type TransactionResponse = {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  status: string;
  kind: string;
  money: { amount: string; currency: string };
  failureCode?: string;
};

type SubmitResponse = {
  transactionId: string;
  status: string;
  idempotentReplay?: boolean;
  failureCode?: string;
};

type ReconciliationResponse = {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, init);
  const text = await response.text();

  let body: unknown = undefined;

  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  return {
    status: response.status,
    body: body as T,
  };
}

async function createWallet(
  baseUrl: string,
  initialAmount: string,
): Promise<WalletResponse> {
  const playerId = crypto.randomUUID();

  const result = await requestJson<WalletResponse>(
    `${baseUrl}/wallets`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: {
          amount: initialAmount,
          currency: CURRENCY,
        },
      }),
    },
  );

  expect(result.status).toBe(201);
  expect(result.body.id).toBeTruthy();

  return result.body;
}

function buildBet(
  wallet: WalletResponse,
  externalTransactionId: string,
  amount: string,
) {
  return {
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'distributed-e2e-game',
    kind: 'BET',
    money: {
      amount,
      currency: CURRENCY,
    },
  };
}

async function submitBet(
  baseUrl: string,
  idempotencyKey: string,
  payload: ReturnType<typeof buildBet>,
) {
  return requestJson<SubmitResponse>(
    `${baseUrl}/wagering/transactions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    },
  );
}

async function waitForTransaction(
  baseUrl: string,
  externalTransactionId: string,
  timeoutMs = 20_000,
): Promise<TransactionResponse> {
  const url =
    `${baseUrl}/providers/${encodeURIComponent(PROVIDER_ID)}` +
    `/wagering/transactions/${encodeURIComponent(externalTransactionId)}`;

  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'NOT_FOUND';

  while (Date.now() < deadline) {
    const result = await requestJson<TransactionResponse>(url);

    if (result.status === 200) {
      const transaction = result.body;
      lastStatus = transaction.status;

      if (
        transaction.status === 'PROCESSED' ||
        transaction.status === 'REJECTED' ||
        transaction.status === 'FAILED'
      ) {
        return transaction;
      }
    }

    await sleep(250);
  }

  throw new Error(
    `Transaction ${externalTransactionId} did not reach a final state. ` +
      `Last status: ${lastStatus}`,
  );
}

async function getWallet(
  baseUrl: string,
  walletId: string,
): Promise<WalletResponse> {
  const result = await requestJson<WalletResponse>(
    `${baseUrl}/wallets/${walletId}`,
  );

  expect(result.status).toBe(200);
  return result.body;
}

async function reconcileWallet(
  baseUrl: string,
  walletId: string,
): Promise<ReconciliationResponse> {
  const result = await requestJson<ReconciliationResponse>(
    `${baseUrl}/wallets/${walletId}/reconciliation`,
    { method: 'POST' },
  );

  expect(result.status).toBe(200);
  return result.body;
}

describe('Distributed NestJS instances - E2E', () => {
  beforeAll(async () => {
    for (const url of APP_URLS) {
      const response = await fetch(`${url}/health/live`);

      expect(
        response.status,
        `Health check failed for ${url}`,
      ).toBe(200);
    }
  }, 30_000);

  it('processes the same BET only once across three instances', async () => {
    const wallet = await createWallet(APP_URLS[0], '100.00');
    const externalId = `bet-${crypto.randomUUID()}`;
    const idempotencyKey = `idem-${crypto.randomUUID()}`;
    const payload = buildBet(wallet, externalId, '10.00');

    const submissions = await Promise.all(
      APP_URLS.map((url) =>
        submitBet(url, idempotencyKey, payload),
      ),
    );

    for (const submission of submissions) {
      expect(submission.status).toBeLessThan(500);
    }

    const transactions = await Promise.all(
      APP_URLS.map((url) => waitForTransaction(url, externalId)),
    );

    expect(
      new Set(transactions.map((transaction) => transaction.transactionId)).size,
    ).toBe(1);

    expect(
      transactions.every((transaction) => transaction.status === 'PROCESSED'),
    ).toBe(true);

    const currentWallet = await getWallet(APP_URLS[1], wallet.id);
    expect(currentWallet.balance).toEqual({
      amount: '90.00',
      currency: CURRENCY,
    });

    const reconciliation = await reconcileWallet(
      APP_URLS[2],
      wallet.id,
    );

    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.difference.amount).toBe('0.00');
  }, 60_000);

  it('rejects reusing an idempotency key with a different payload', async () => {
    const wallet = await createWallet(APP_URLS[0], '100.00');
    const externalId = `conflict-${crypto.randomUUID()}`;
    const idempotencyKey = `idem-${crypto.randomUUID()}`;

    const originalPayload = buildBet(wallet, externalId, '10.00');

    const first = await submitBet(
      APP_URLS[0],
      idempotencyKey,
      originalPayload,
    );

    expect(first.status).toBeLessThan(500);

    const originalTransaction = await waitForTransaction(
      APP_URLS[0],
      externalId,
    );

    expect(originalTransaction.status).toBe('PROCESSED');

    const conflictingPayload = {
      ...originalPayload,
      money: { amount: '20.00', currency: CURRENCY },
    };

    const conflict = await submitBet(
      APP_URLS[1],
      idempotencyKey,
      conflictingPayload,
    );

    expect([400, 409, 422]).toContain(conflict.status);

    const currentWallet = await getWallet(APP_URLS[2], wallet.id);

    expect(currentWallet.balance).toEqual({
      amount: '90.00',
      currency: CURRENCY,
    });

    const reconciliation = await reconcileWallet(
      APP_URLS[0],
      wallet.id,
    );

    expect(reconciliation.consistent).toBe(true);
  }, 60_000);

  it('does not allow concurrent BETs to overspend a wallet', async () => {
    const wallet = await createWallet(APP_URLS[0], '10.00');

    const firstId = `race-a-${crypto.randomUUID()}`;
    const secondId = `race-b-${crypto.randomUUID()}`;

    const firstPayload = buildBet(wallet, firstId, '10.00');
    const secondPayload = buildBet(wallet, secondId, '10.00');

    const submissions = await Promise.all([
      submitBet(APP_URLS[0], `idem-${crypto.randomUUID()}`, firstPayload),
      submitBet(APP_URLS[1], `idem-${crypto.randomUUID()}`, secondPayload),
    ]);

    for (const submission of submissions) {
      expect(submission.status).toBeLessThan(500);
    }

    const outcomes = await Promise.all([
      waitForTransaction(APP_URLS[0], firstId),
      waitForTransaction(APP_URLS[2], secondId),
    ]);

    expect(
      outcomes.filter((transaction) => transaction.status === 'PROCESSED'),
    ).toHaveLength(1);

    expect(
      outcomes.filter((transaction) => transaction.status === 'REJECTED'),
    ).toHaveLength(1);

    const currentWallet = await getWallet(APP_URLS[1], wallet.id);

    expect(currentWallet.balance).toEqual({
      amount: '0.00',
      currency: CURRENCY,
    });

    const reconciliation = await reconcileWallet(
      APP_URLS[2],
      wallet.id,
    );

    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.difference.amount).toBe('0.00');
  }, 60_000);
});
