import { NestFactory } from '@nestjs/core';
import { AppModule } from './infra/app.module.js';
import { env } from './infra/env.js';
import { HttpExceptionFilter } from './infra/http/filters/http-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule,{
    // logger: false,
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  
  await app.listen(env.PORT);
}
await bootstrap();
