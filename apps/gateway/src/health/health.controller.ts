import { Controller, Get } from '@nestjs/common';

export interface LivenessResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  /** Liveness: the process is up and serving HTTP. No dependency checks (see /health/ready in M1). */
  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }
}
