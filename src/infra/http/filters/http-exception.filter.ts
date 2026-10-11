import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { WalletAlreadyExistsError } from '../../../domain/wallets/application/errors/wallet-already-exists-error.js';
import { WalletNotFoundError } from '../../../domain/wallets/application/errors/wallet-not-found-error.js';
import { DomainError } from '../../../core/domain/domain-error.js';
import { IdempotencyConflictError } from '../../../domain/wagering/application/errors/idempotency-conflict-error.js';
import { WagerTransactionAlreadyExistsError } from '../../../domain/wagering/application/errors/wager-transaction-already-exists-error.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ZodError) {
      response.status(400).json({
        message: 'Validation failed',
        issues: exception.issues,
      });
      return;
    }

    if (exception instanceof WalletAlreadyExistsError) {
      response.status(409).json({ message: exception.message });
      return;
    }

    if (exception instanceof WalletNotFoundError) {
      response.status(404).json({ message: exception.message });
      return;
    }

    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof WagerTransactionAlreadyExistsError
    ) {
      response.status(409).json({ message: exception.message });
      return;
    }

    if (exception instanceof DomainError) {
      response.status(400).json({ message: exception.message });
      return;
    }

    response.status(500).json({ message: 'Internal server error' });
  }
}
