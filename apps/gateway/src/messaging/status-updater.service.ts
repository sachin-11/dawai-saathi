import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { DeliveryStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import type { StatusUpdate } from '../webhook/inbound-message';
import { MessagesService, type StatusApplyResult } from './messages.service';

const KNOWN_STATUSES = new Set<string>(['sent', 'delivered', 'read', 'failed']);

/**
 * A fast `delivered` receipt can reach us before our own insert of the outbound row (we only know
 * Meta's message id after the send call returns). When the row is not there yet, retry a few times
 * shortly after. The retries are in-process timers: receipts are best-effort, so losing a retry on
 * a restart is acceptable (no need for a durable job).
 */
export const NOT_FOUND_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000];

@Injectable()
export class StatusUpdater implements OnModuleDestroy {
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Overridable in tests. */
  retryDelaysMs: readonly number[] = NOT_FOUND_RETRY_DELAYS_MS;

  constructor(
    private readonly messages: MessagesService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StatusUpdater.name);
  }

  /** Apply one status webhook item. Throws only on infrastructure failure (so Meta retries). */
  async apply(update: StatusUpdate): Promise<void> {
    if (!KNOWN_STATUSES.has(update.status)) {
      this.logger.info({ status: update.status }, 'ignored unknown whatsapp status');
      return;
    }
    const result = await this.tryApply(update);
    this.logger.info(
      {
        wa_message_id: update.waMessageId,
        status: update.status,
        result,
        ...(update.errorCode !== undefined ? { error_code: update.errorCode } : {}),
      },
      'whatsapp status update',
    );
    if (result === 'not_found') {
      this.scheduleRetry(update, 0);
    }
  }

  private tryApply(update: StatusUpdate): Promise<StatusApplyResult> {
    return this.messages.applyStatus({
      waMessageId: update.waMessageId,
      status: update.status as DeliveryStatus,
      at: update.timestamp ?? new Date(),
      errorCode: update.errorCode !== undefined ? String(update.errorCode) : undefined,
    });
  }

  private scheduleRetry(update: StatusUpdate, attempt: number): void {
    const delay = this.retryDelaysMs[attempt];
    if (delay === undefined) {
      this.logger.info(
        { wa_message_id: update.waMessageId, status: update.status },
        'status for an unknown outbound message, giving up',
      );
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.tryApply(update)
        .then((result) => {
          if (result === 'not_found') {
            this.scheduleRetry(update, attempt + 1);
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { error: error instanceof Error ? error.name : 'unknown' },
            'status retry failed',
          );
        });
    }, delay);
    timer.unref();
    this.timers.add(timer);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
