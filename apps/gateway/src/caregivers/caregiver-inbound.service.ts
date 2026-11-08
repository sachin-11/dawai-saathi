import { Injectable } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { normaliseForMatching } from '../common/safety/normalise';
import { parseCaregiverReply } from '../conversation/commands';
import { ReminderQueue } from '../reminders/reminder.queue';
import type { InboundMessage } from '../webhook/inbound-message';
import { CaregiversService } from './caregivers.service';

/**
 * Caregiver messages are recognised by the sender's number BEFORE normal onboarding: a caregiver is
 * not automatically a user. Only YES / NO (while an invite is waiting) and STOP ALERTS are caregiver
 * answers; anything else from that number falls through to the normal flow, where the person can
 * onboard for themselves.
 */
@Injectable()
export class CaregiverInboundService {
  constructor(
    private readonly caregivers: CaregiversService,
    private readonly queue: ReminderQueue,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** True when the message was a caregiver answer and has been handed to the worker. */
  async tryHandle(message: InboundMessage): Promise<boolean> {
    if (message.type !== 'text' || message.text === undefined) return false;
    const rows = await this.caregivers.findByPhone(message.from);
    if (rows.length === 0) return false;

    // Their own message opens THEIR 24 h window, which is what lets us confirm in plain text.
    await this.caregivers.touchInbound(
      rows.map((row) => row.id),
      message.timestamp,
    );

    let reply = parseCaregiverReply(message.text);
    if (reply === null && normaliseForMatching(message.text) === 'stop') {
      // A bare STOP means "stop the alerts" only for someone who is NOT also a user (for a user it
      // is STOP REMINDERS).
      const isUser = await this.prisma.user.findUnique({
        where: { waPhoneHash: this.crypto.hashPhone(message.from) },
        select: { id: true },
      });
      if (!isUser) reply = 'stop_alerts';
    }
    if (reply === null) return false;

    const targets = reply === 'stop_alerts' ? rows : rows.filter((row) => row.status === 'pending');
    if (targets.length === 0) return false;

    for (const row of targets) {
      await this.queue.addCaregiverReply({
        userId: row.userId,
        caregiverId: row.id,
        reply,
        waMessageId: message.waMessageId,
      });
    }
    return true;
  }
}
