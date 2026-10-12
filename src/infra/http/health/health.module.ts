import { Module } from '@nestjs/common';
import { HealthController } from '../controllers/health.controller.js';
import { HealthCheckService } from './health-check.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthCheckService],
})
export class HealthModule {}
