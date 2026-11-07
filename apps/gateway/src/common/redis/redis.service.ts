import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

import { APP_CONFIG } from '../../config/config.constants';
import type { Env } from '../../config/env.schema';

/**
 * Single place that knows how to connect to Redis.
 *
 *  - `client`            shared general-purpose connection (health checks, small commands).
 *  - `createConnection`  factory for everyone else. BullMQ (M2) needs its own connections, and
 *                        workers require `maxRetriesPerRequest: null`, so queues call
 *                        `createConnection({ maxRetriesPerRequest: null })` instead of sharing `client`.
 *
 * Connections are lazy: nothing is opened until first use, so the app boots without Redis.
 * Every connection created here is closed on shutdown.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly connections = new Set<Redis>();
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) private readonly env: Env) {
    // Fail commands fast instead of queueing forever while Redis is down.
    this.client = this.createConnection({ maxRetriesPerRequest: 1 });
  }

  createConnection(overrides: RedisOptions = {}): Redis {
    const connection = new Redis(this.env.REDIS_URL, {
      lazyConnect: true,
      connectionName: 'dawai-gateway',
      ...overrides,
    });
    // Without an 'error' listener ioredis would throw on connection errors and crash the process.
    // Log the code only: messages can contain the connection string.
    connection.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.warn(`redis connection error: ${error.code ?? error.name}`);
    });
    this.connections.add(connection);
    return connection;
  }

  /** Round-trip PING. Throws if Redis is unreachable. */
  async healthCheck(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end') {
      await this.client.connect();
    }
    await this.client.ping(); // rejects if Redis is unreachable
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.connections].map(async (connection) => {
        try {
          if (connection.status === 'ready') {
            await connection.quit();
          } else {
            connection.disconnect();
          }
        } catch {
          connection.disconnect();
        }
      }),
    );
    this.connections.clear();
  }
}
