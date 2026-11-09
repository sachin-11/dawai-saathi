import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AI_ERROR_REPLY_INDEX } from '../conversation/reply-indexes';
import { RepliesService } from '../conversation/replies.service';
import { DlqService } from '../telemetry/dlq.service';
import { UsersService } from '../users/users.service';

/**
 * What happens to a dead letter (M15), per queue:
 *   inbound        the user gets "something went wrong, please try again" EXACTLY ONCE: the outbound job
 *                  id is `<messageId>_99`, the same one the AI-failure path uses, so BullMQ dedupes
 *   user-deletion  an erasure that cannot finish is a legal problem: a `user_erasure_dlq` error log and
 *                  `dlq_size{queue="user-deletion"} > 0` (alert `UserErasureDeadLetter`, page at once)
 *   outbound,
 *   reminders      counted and alerted by size only (a failed send has no one to tell)
 */
@Injectable()
export class DlqEffects implements OnModuleInit {
  constructor(
    private readonly dlq: DlqService,
    private readonly users: UsersService,
    private readonly replies: RepliesService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DlqEffects.name);
  }

  onModuleInit(): void {
    this.dlq.register('inbound', async (entry) => {
      if (!entry.userId || !entry.messageId) return;
      const user = await this.users.getState(entry.userId);
      if (!user) return; // erased meanwhile
      await this.replies
        .session({
          userId: user.id,
          language: user.language,
          messageId: entry.messageId,
          requestId: 'dlq',
        })
        .textAt(AI_ERROR_REPLY_INDEX, 'common.error_try_again');
    });
    this.dlq.register('user-deletion', (entry) => {
      this.logger.error(
        {
          event: 'user_erasure_dlq',
          job_id: entry.sourceJobId,
          attempts_made: entry.attemptsMade,
          error_code: entry.errorCode,
          trace_id: entry.traceId,
        },
        'USER ERASURE IS STUCK: operator action required (pnpm cli dlq:retry --queue user-deletion)',
      );
      return Promise.resolve();
    });
  }
}
