import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { OpenWalletUseCase } from '../../../domain/wallets/application/use-cases/open-wallet.js';

const openWalletBodySchema = z.object({
  playerId: z.uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

@Controller('wallets')
export class WalletsController {
  constructor(private readonly openWallet: OpenWalletUseCase) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const request = openWalletBodySchema.parse(body);
    const { wallet } = await this.openWallet.execute(request);

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
