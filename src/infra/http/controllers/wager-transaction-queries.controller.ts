import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';
import { GetWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/get-wager-transaction.js';
import type { WagerTransaction } from '../../../domain/wagering/enterprise/entities/wager-transaction.js';

@Controller()
export class WagerTransactionQueriesController {
  constructor(
    private readonly getWagerTransaction: GetWagerTransactionUseCase,
  ) {}

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId') transactionId: string) {
    const id = z.uuid().parse(transactionId);
    const { transaction } = await this.getWagerTransaction.findById(id);

    return this.toResponse(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const provider = z.string().trim().min(1).max(255).parse(providerId);
    const externalId = z.string().trim().min(1).max(255).parse(
      externalTransactionId,
    );
    const { transaction } =
      await this.getWagerTransaction.findByProviderAndExternalTransactionId(
        provider,
        externalId,
      );

    return this.toResponse(transaction);
  }

  private toResponse(transaction: WagerTransaction) {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      money: transaction.money.toJSON(),
      ...(transaction.resultingBalance
        ? { resultingBalance: transaction.resultingBalance.toJSON() }
        : {}),
      ...(transaction.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
          }
        : {}),
      ...(transaction.referenceTransactionId
        ? { referenceTransactionId: transaction.referenceTransactionId }
        : {}),
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : {}),
      createdAt: transaction.createdAt,
      ...(transaction.processedAt
        ? { processedAt: transaction.processedAt }
        : {}),
    };
  }
}
