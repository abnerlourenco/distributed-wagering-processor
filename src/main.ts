import { NestFactory } from '@nestjs/core';
import { StructuredLogger } from './infra/observability/structured-logger.js';
import { AppModule } from './infra/app.module.js';
import { env } from './infra/env.js';
import { HttpExceptionFilter } from './infra/http/filters/http-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger(),
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);

  await app.listen(env.PORT);
}
await bootstrap();
