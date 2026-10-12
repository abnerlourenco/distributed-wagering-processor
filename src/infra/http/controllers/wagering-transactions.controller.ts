import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Money } from '../../../core/domain/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/enterprise/entities/wager-transaction.js';
import { QueueWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/queue-wager-transaction.js';
import { addObservationFields } from '../../observability/observation-context.js';

const submitWagerTransactionBodySchema = z
  .object({
    providerId: z.string().trim().min(1).max(255),
    externalTransactionId: z.string().trim().min(1).max(255),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().trim().min(1).max(255),
    gameId: z.string().trim().min(1).max(255),
    kind: z.enum([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    money: z
      .object({
        amount: z.string().regex(/^\d{1,18}\.\d{2}$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
    referenceExternalTransactionId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      (request.kind === WagerTransactionKind.Refund ||
        request.kind === WagerTransactionKind.Rollback) &&
      !request.referenceExternalTransactionId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: `${request.kind} requires a referenced external transaction id`,
      });
    }

    if (
      request.referenceExternalTransactionId &&
      request.kind !== WagerTransactionKind.Win &&
      request.kind !== WagerTransactionKind.Refund &&
      request.kind !== WagerTransactionKind.Rollback
    ) {
      context.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'This transaction kind does not accept a reference',
      });
    }
  });

const idempotencyKeySchema = z.string().trim().min(1).max(255);

@Controller('wagering/transactions')
export class WageringTransactionsController {
  constructor(
    private readonly queueTransaction: QueueWagerTransactionUseCase,
  ) {}

  @Post()
  @HttpCode(202)
  async submit(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const request = submitWagerTransactionBodySchema.parse(body);
    const key = idempotencyKeySchema.parse(idempotencyKey);
    addObservationFields({
      walletId: request.walletId,
      providerId: request.providerId,
    });
    const result = await this.queueTransaction.execute({
      ...request,
      idempotencyKey: key,
      money: Money.from(request.money),
    });
    addObservationFields({ transactionId: result.transaction.id });

    if (result.transaction.status === WagerTransactionStatus.Rejected) {
      response.status(422);
    } else if (result.transaction.status === WagerTransactionStatus.Processed) {
      response.status(200);
    }

    return {
      transactionId: result.transaction.id,
      status: result.transaction.status,
      ...((result.balance ?? result.transaction.resultingBalance)
        ? {
            balance: (
              result.balance ?? result.transaction.resultingBalance
            )?.toJSON(),
          }
        : {}),
      ...(result.transaction.failureCode
        ? { failureCode: result.transaction.failureCode }
        : {}),
      idempotentReplay: result.idempotentReplay,
    };
  }
}
