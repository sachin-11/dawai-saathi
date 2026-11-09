import { Controller, Get, HttpStatus, type OnApplicationBootstrap, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ReadinessService, type ReadinessReport } from './readiness.service';

export interface LivenessResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController implements OnApplicationBootstrap {
  private started = false;

  constructor(private readonly readiness: ReadinessService) {}

  onApplicationBootstrap(): void {
    this.started = true;
  }

  /** Startup probe (M15): 503 until Nest finished booting, so a slow start is not killed as unhealthy. */
  @Get('startup')
  startup(@Res({ passthrough: true }) res: Response): { status: 'ok' | 'starting' } {
    if (!this.started) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'starting' };
    }
    return { status: 'ok' };
  }

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
