import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { Money } from '../../../core/domain/money.js';
import { GetWalletUseCase } from '../../../domain/wallets/application/use-cases/get-wallet.js';
import {
  GetWalletLedgerUseCase,
  MAX_WALLET_LEDGER_PAGE_SIZE,
} from '../../../domain/wallets/application/use-cases/get-wallet-ledger.js';
import { OpenWalletUseCase } from '../../../domain/wallets/application/use-cases/open-wallet.js';
import { ReconcileWalletUseCase } from '../../../domain/wallets/application/use-cases/reconcile-wallet.js';
import { addObservationFields } from '../../observability/observation-context.js';

const openWalletBodySchema = z.object({
  playerId: z.uuid(),
  initialBalance: z.object({
    amount: z.string().regex(/^\d{1,18}\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
});

const walletLedgerQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_WALLET_LEDGER_PAGE_SIZE))
      .optional(),
  })
  .strict();

@Controller('wallets')
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getWalletLedger: GetWalletLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query() query: unknown,
  ) {
    const id = z.uuid().parse(walletId);
    addObservationFields({ walletId: id });
    const request = walletLedgerQuerySchema.parse(query);
    const { entries, nextCursor } = await this.getWalletLedger.execute({
      walletId: id,
      ...request,
    });

    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt,
      })),
      nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const id = z.uuid().parse(walletId);
    addObservationFields({ walletId: id });
    const result = await this.reconcileWallet.execute(id);

    if (!result.consistent) {
      this.logger.warn(
        `Wallet ledger reconciliation mismatch for wallet ${id} across ${result.checkedEntries} entries`,
      );
    }

    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }

  @Get(':walletId')
  async findById(@Param('walletId') walletId: string) {
    const id = z.uuid().parse(walletId);
    addObservationFields({ walletId: id });
    const { wallet } = await this.getWallet.execute(id);

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const request = openWalletBodySchema.parse(body);
    const { wallet } = await this.openWallet.execute({
      playerId: request.playerId,
      initialBalance: Money.from(request.initialBalance),
    });
    addObservationFields({ walletId: wallet.id });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }
}
