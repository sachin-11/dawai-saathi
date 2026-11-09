import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Job, Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { InboundRouter } from '../conversation/inbound-router';
import { RedisService } from '../common/redis/redis.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { INBOUND_QUEUE, type InboundJobData } from './queue.constants';
import { WorkerFactory } from '../telemetry/worker-factory.service';

/**
 * Consumer of the `inbound` queue. Every job goes through the InboundRouter (M4): emergency check,
 * commands, onboarding/consent, and only then (for consented users) the processing branch, which is
 * still a placeholder until the AI service arrives (M5+).
 */
@Injectable()
export class InboundWorker implements OnModuleInit, OnModuleDestroy {
  private worker: Worker<InboundJobData> | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly router: InboundRouter,
    private readonly workers: WorkerFactory,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InboundWorker.name);
  }

  onModuleInit(): void {
    if (!this.env.WORKERS_ENABLED) {
      this.logger.info('inbound worker disabled (WORKERS_ENABLED=false)');
      return;
    }

    this.worker = this.workers.create<InboundJobData>(INBOUND_QUEUE, (job) => this.process(job), {
      // Workers need blocking commands that must never give up: maxRetriesPerRequest: null.
      connection: this.redis.createConnection({ maxRetriesPerRequest: null }),
      concurrency: 5,
    });
    this.worker.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.warn(`inbound worker error: ${error.code ?? error.name}`);
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        { job_id: job?.id, attempts_made: job?.attemptsMade, error: error.name },
        'inbound job failed',
      );
    });
  }

  /** Log ids only (no phone number, no text), then let the router decide what happens. */
  async process(job: Job<InboundJobData>): Promise<void> {
    const { messageId, userId, waMessageId, type, requestId } = job.data;
    this.logger.info(
      {
        job_id: job.id,
        message_id: messageId,
        user_id: userId,
        wa_message_id: waMessageId,
        type,
        request_id: requestId,
      },
      'inbound job received',
    );
    const outcome = await this.router.route(job.data);
    this.logger.info({ job_id: job.id, outcome, request_id: requestId }, 'inbound job routed');
  }

  /** Waits for in-flight jobs to finish, then stops. */
  async onModuleDestroy(): Promise<void> {
    await this.workers.close(this.worker);
  }
}
