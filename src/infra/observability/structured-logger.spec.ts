import { describe, expect, it } from 'vitest';
import { runWithObservationContext } from './observation-context.js';
import { StructuredLogger } from './structured-logger.js';

describe('StructuredLogger', () => {
  it('writes JSON correlation fields and does not serialize object payloads', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((_stream, line) => lines.push(line));

    runWithObservationContext(
      {
        correlationId: 'correlation-123',
        messageId: 'message-123',
        transactionId: 'transaction-123',
        walletId: 'wallet-123',
        providerId: 'provider-123',
      },
      () => logger.log({ amount: '25.00', currency: 'BRL' }),
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'log',
      message: 'Structured application log',
      correlationId: 'correlation-123',
      messageId: 'message-123',
      transactionId: 'transaction-123',
      walletId: 'wallet-123',
      providerId: 'provider-123',
    });
    expect(lines[0]).not.toContain('25.00');
  });
});
