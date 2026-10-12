import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/infra/app.module.js';
import { OutboxEventConsumerWorker } from '../src/infra/messaging/inbox/outbox-event-consumer.worker.js';
import { OutboxPublisherWorker } from '../src/infra/messaging/outbox/outbox-publisher.worker.js';
import { WagerCommandConsumerWorker } from '../src/infra/messaging/commands/wager-command-consumer.worker.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OutboxEventConsumerWorker)
      .useValue({})
      .overrideProvider(OutboxPublisherWorker)
      .useValue({})
      .overrideProvider(WagerCommandConsumerWorker)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('keeps liveness independent of database readiness', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'alive' });
  });

  it('reports readiness after checking PostgreSQL', async () => {
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ready', checks: { database: 'up' } });
  });

  afterEach(async () => {
    await app.close();
  });
});
