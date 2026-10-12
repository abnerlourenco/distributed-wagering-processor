import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AppController } from './http/controllers/app.controller.js';
import { AppService } from './http/app.service.js';
import { mikroOrmConfig } from './database/mikro-orm.config.js';
import { WalletsModule } from './http/wallets/wallets.module.js';
import { WageringModule } from './http/wagering/wagering.module.js';
import { HealthModule } from './http/health/health.module.js';
import { MessagingModule } from './messaging/messaging.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    WalletsModule,
    WageringModule,
    HealthModule,
    MessagingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
