import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Money } from '../../../core/domain/money.js';
import { ProcessWagerTransactionUseCase } from '../../../domain/wagering/application/use-cases/process-wager-transaction.js';
import { MikroOrmPendingReferenceRetriesRepository } from '../../database/mikro-orm/repositories/mikro-orm-pending-reference-retries.repository.js';

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 10;
const ERROR_DELAY_MS = 5000;

@Injectable()
export class PendingReferenceRetryWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PendingReferenceRetryWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly repository: MikroOrmPendingReferenceRetriesRepository,
    private readonly processTransaction: ProcessWagerTransactionUseCase,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.retryCycle();
    }, delayMs);
  }

  private async retryCycle(): Promise<void> {
    let nextDelay = POLL_INTERVAL_MS;
    try {
      const dueTransactions = await this.repository.claimDue(BATCH_SIZE);
      for (const transaction of dueTransactions) {
        if (this.stopped) {
          break;
        }

        try {
          await this.processTransaction.execute({
            transactionId: transaction.id,
            createdAt: new Date(transaction.createdAt),
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind,
            money: Money.from({
              amount: transaction.amount,
              currency: transaction.currency,
            }),
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
          });
        } catch (error) {
          const errorName =
            error instanceof Error ? error.name : 'UnknownRetryError';
          this.logger.error(
            `Pending reference retry failed for transaction ${transaction.id} (${errorName})`,
          );
        }
      }
    } catch (error) {
      const errorName =
        error instanceof Error ? error.name : 'UnknownRetryWorkerError';
      this.logger.error(`Pending reference retry cycle failed (${errorName})`);
      nextDelay = ERROR_DELAY_MS;
    } finally {
      this.schedule(nextDelay);
    }
  }
}
