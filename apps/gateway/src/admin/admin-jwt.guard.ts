import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { WINDOW_STORE } from '../limits/limits.constants';
import type { WindowStore } from '../limits/sliding-window';
import { MetricsService } from '../telemetry/metrics.service';
import { verifyAdminJwt } from './admin-jwt';
import { AdminError } from './admin.errors';

export interface AdminRequest extends Request {
  admin?: { email: string };
}

const ADMIN_PER_MINUTE = 120;

/**
 * Every `/admin/*` call must carry a fresh JWT from the Next.js server. With no secret or no allowlist
 * configured the routes do not exist (404). Rate limited per operator.
 */
@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Pick<Env, 'ADMIN_EMAILS' | 'ADMIN_JWT_SECRET'>,
    @Inject(WINDOW_STORE) private readonly windows: WindowStore,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AdminJwtGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secret = this.env.ADMIN_JWT_SECRET;
    const allowlist = this.env.ADMIN_EMAILS ?? [];
    if (!secret || allowlist.length === 0) throw new NotFoundException();

    const http = context.switchToHttp();
    const request = http.getRequest<AdminRequest>();
    http.getResponse<Response>().setHeader('Cache-Control', 'no-store');
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const result = verifyAdminJwt(token, secret, allowlist);
    if (!result.ok) {
      this.metrics.webRequests.inc({ channel: 'admin', status: `denied_${result.reason}` });
      this.logger.warn({ reason: result.reason }, 'admin request denied');
      throw new UnauthorizedException();
    }

    const hit = await this.windows.hit(`admin:rl:${result.email}`, ADMIN_PER_MINUTE, 60_000);
    if (!hit.allowed) {
      this.metrics.webRequests.inc({ channel: 'admin', status: 'rate_limited' });
      throw new AdminError(
        'rate_limited',
        HttpStatus.TOO_MANY_REQUESTS,
        Math.ceil(hit.retryAfterMs / 1000),
      );
    }
    request.admin = { email: result.email };
    return true;
  }
}
