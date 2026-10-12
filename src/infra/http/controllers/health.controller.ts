import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthCheckService } from '../health/health-check.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthCheck: HealthCheckService) {}

  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'alive' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) response: Response) {
    const result = await this.healthCheck.checkReadiness();
    if (result.status === 'not_ready') {
      response.status(503);
    }

    return result;
  }
}
