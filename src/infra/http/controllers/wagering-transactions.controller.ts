import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Money } from '../../../core/domain/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/enterprise/entities/wager-transaction.js';
import { ProcessWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/process-wager-transaction.js';

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
    ]),
    money: z.object({
      amount: z.string().regex(/^\d{1,18}\.\d{2}$/),
      currency: z.string().regex(/^[A-Z]{3}$/),
    }).strict(),
    referenceExternalTransactionId: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.kind === WagerTransactionKind.Refund &&
      !request.referenceExternalTransactionId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'REFUND requires a referenced external transaction id',
      });
    }

    if (
      request.referenceExternalTransactionId &&
      request.kind !== WagerTransactionKind.Win &&
      request.kind !== WagerTransactionKind.Refund
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
    private readonly processTransaction: ProcessWagerTransactionUseCase,
  ) {}

  @Post()
  @HttpCode(200)
  async submit(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const request = submitWagerTransactionBodySchema.parse(body);
    const key = idempotencyKeySchema.parse(idempotencyKey);
    const result = await this.processTransaction.execute({
      ...request,
      idempotencyKey: key,
      money: Money.from(request.money),
    });

    if (result.transaction.status === WagerTransactionStatus.Rejected) {
      response.status(422);
    } else if (
      result.transaction.status === WagerTransactionStatus.PendingReference
    ) {
      response.status(202);
    }

    return {
      transactionId: result.transaction.id,
      status: result.transaction.status,
      balance: result.balance.toJSON(),
      ...(result.transaction.failureCode
        ? { failureCode: result.transaction.failureCode }
        : {}),
      idempotentReplay: result.idempotentReplay,
    };
  }
}
