import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  runWithObservationContext,
  type ObservationContext,
} from './observation-context.js';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class CorrelationMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const requestedId = request.header('x-correlation-id');
    const correlationId =
      requestedId && CORRELATION_ID_PATTERN.test(requestedId)
        ? requestedId
        : randomUUID();
    const context: ObservationContext = { correlationId };
    const startedAt = performance.now();

    response.setHeader('x-correlation-id', correlationId);
    runWithObservationContext(context, () => {
      response.once('finish', () => {
        process.stdout.write(
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'log',
            context: 'HttpRequest',
            event: 'http_request_completed',
            correlationId,
            messageId: null,
            transactionId: context.transactionId ?? null,
            walletId: context.walletId ?? null,
            providerId: context.providerId ?? null,
            method: request.method,
            statusCode: response.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
          })}\n`,
        );
      });
      next();
    });
  }
}
