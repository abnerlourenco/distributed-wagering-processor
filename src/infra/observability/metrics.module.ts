import { Global, Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsRegistry } from './metrics-registry.js';

@Global()
@Module({
  imports: [MessagingModule],
  controllers: [MetricsController],
  providers: [MetricsRegistry],
  exports: [MetricsRegistry],
})
export class MetricsModule {}
