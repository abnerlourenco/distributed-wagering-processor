import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { HealthController } from '../src/infra/http/controllers/health.controller.js';
import {
  HealthCheckService,
  type ReadinessResult,
} from '../src/infra/http/health/health-check.service.js';

describe('Health HTTP', () => {
  let app: INestApplication<App>;
  let readinessResult: ReadinessResult;
  let readinessCalls: number;

  beforeEach(async () => {
    readinessResult = {
      status: 'ready',
      checks: {
        database: 'up',
        commandQueue: 'up',
        deadLetterQueue: 'up',
      },
    };
    readinessCalls = 0;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: {
            checkReadiness: async () => {
              readinessCalls += 1;
              return readinessResult;
            },
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns liveness without probing dependencies', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'alive' });

    expect(readinessCalls).toBe(0);
  });

  it('returns 503 and the failed dependency when PostgreSQL is unavailable', async () => {
    readinessResult = {
      status: 'not_ready',
      checks: {
        database: 'down',
        commandQueue: 'up',
        deadLetterQueue: 'up',
      },
    };

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503)
      .expect({
        status: 'not_ready',
        checks: {
          database: 'down',
          commandQueue: 'up',
          deadLetterQueue: 'up',
        },
      });
  });

  it('returns 503 when a required SQS queue is unavailable', async () => {
    readinessResult = {
      status: 'not_ready',
      checks: {
        database: 'up',
        commandQueue: 'down',
        deadLetterQueue: 'up',
      },
    };

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503)
      .expect({
        status: 'not_ready',
        checks: {
          database: 'up',
          commandQueue: 'down',
          deadLetterQueue: 'up',
        },
      });
  });
});
