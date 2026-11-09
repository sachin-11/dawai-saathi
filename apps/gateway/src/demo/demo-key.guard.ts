import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { safeEqual } from '../common/crypto/safe-equal';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';

/**
 * `X-Demo-Key` must equal DEMO_API_KEY (constant time). The key is known only to the Next.js server,
 * so the browser can never call this API directly. With no key configured the routes do not exist (404).
 */
@Injectable()
export class DemoKeyGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly env: Pick<Env, 'DEMO_API_KEY'>) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.env.DEMO_API_KEY;
    if (!expected) throw new NotFoundException();
    const header = context.switchToHttp().getRequest<Request>().headers['x-demo-key'];
    const provided = typeof header === 'string' ? header : '';
    if (!safeEqual(provided, expected)) throw new UnauthorizedException();
    return true;
  }
}
