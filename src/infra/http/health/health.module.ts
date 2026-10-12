import { Module } from '@nestjs/common';
import { HealthController } from '../controllers/health.controller.js';
import { HealthCheckService } from './health-check.service.js';
import { MessagingModule } from '../../messaging/messaging.module.js';

@Module({
  imports: [MessagingModule],
  controllers: [HealthController],
  providers: [HealthCheckService],
})
export class HealthModule {}
