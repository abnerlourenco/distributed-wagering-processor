import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { SqsMessageAdapter } from '../messaging/sqs/sqs-message-adapter.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsRegistry } from './metrics-registry.js';

describe('MetricsController', () => {
  it('refreshes transaction, Outbox and DLQ metrics on scrape', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ status: 'PROCESSED', count: '3' }])
      .mockResolvedValueOnce([{ lag_seconds: '1.5' }]);
    const metrics = new MetricsRegistry();
    const module = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        {
          provide: EntityManager,
          useValue: { getConnection: () => ({ execute }) },
        },
        {
          provide: SqsMessageAdapter,
          useValue: { getApproximateQueueDepth: vi.fn().mockResolvedValue(2) },
        },
        { provide: MetricsRegistry, useValue: metrics },
      ],
    }).compile();

    const app = module.createNestApplication();
    await app.init();
    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200)
      .expect('Content-Type', /text\/plain/);
    const output = response.text;

    expect(output).toMatch(
      /wager_transactions\{[^}]*status="PROCESSED"[^}]*\} 3/,
    );
    expect(output).toMatch(/wagering_outbox_lag_seconds\{[^}]*\} 1\.5/);
    expect(output).toMatch(/wagering_dlq_messages\{[^}]*\} 2/);
    expect(execute).toHaveBeenCalledTimes(2);

    await app.close();
  });
});
