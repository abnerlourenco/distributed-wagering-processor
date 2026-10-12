import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CorrelationMiddleware } from './correlation.middleware.js';
import { MetricsModule } from './metrics.module.js';

@Module({
  imports: [MetricsModule],
  providers: [CorrelationMiddleware],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
