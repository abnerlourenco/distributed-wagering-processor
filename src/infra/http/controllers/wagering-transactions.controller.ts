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
import { WagerTransactionStatus } from '../../../domain/wagering/enterprise/entities/wager-transaction.js';
import { ProcessBetUseCase } from '../../../domain/wagering/application/use-cases/process-bet.js';

const submitBetBodySchema = z
  .object({
    providerId: z.string().trim().min(1).max(255),
    externalTransactionId: z.string().trim().min(1).max(255),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().trim().min(1).max(255),
    gameId: z.string().trim().min(1).max(255),
    kind: z.literal('BET'),
    money: z.object({
      amount: z.string().regex(/^\d{1,18}\.\d{2}$/),
      currency: z.string().regex(/^[A-Z]{3}$/),
    }).strict(),
  })
  .strict();

const idempotencyKeySchema = z.string().trim().min(1).max(255);

@Controller('wagering/transactions')
export class WageringTransactionsController {
  constructor(private readonly processBet: ProcessBetUseCase) {}

  @Post()
  @HttpCode(200)
  async submit(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const request = submitBetBodySchema.parse(body);
    const key = idempotencyKeySchema.parse(idempotencyKey);
    const result = await this.processBet.execute({
      ...request,
      idempotencyKey: key,
      money: Money.from(request.money),
    });

    if (result.transaction.status === WagerTransactionStatus.Rejected) {
      response.status(422);
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
