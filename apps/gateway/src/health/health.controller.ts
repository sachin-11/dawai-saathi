import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ReadinessService, type ReadinessReport } from './readiness.service';

export interface LivenessResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness: the process is up and serving HTTP. No dependency checks (that is /health/ready). */
  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  /** Readiness: Postgres, Redis and S3 all answer. 503 (with the same body shape) if any does not. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (report.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
