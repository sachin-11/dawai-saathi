import { Injectable, Optional } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { MetricsService } from '../telemetry/metrics.service';

import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { I18nService, type Language, type MessageKey } from '../messaging/i18n/i18n.service';
import { OutboundService } from '../messaging/outbound.service';
import type { TemplateContent } from '../messaging/outbound.types';
import { isoDate, localDateOf, localTimeOf, epochSeconds } from '../reminders/clock';
import {
  ALERT_MIN_GAP_MS,
  INVITE_TTL_MS,
  MAX_ACTIVE_CAREGIVERS,
  MAX_ALERTS_PER_DAY,
} from '../reminders/reminders.constants';
import type { CaregiverReplyJobData } from '../reminders/reminder.queue';

/** Indian mobile in E.164 digits without "+": 91 followed by 6-9 and nine digits. */
const INDIAN_MOBILE = /^91[6-9]\d{9}$/;

export function isIndianMobile(normalised: string): boolean {
  return INDIAN_MOBILE.test(normalised);
}

/** The name the user gives: letters (any script), spaces, dots, hyphens; 1-20 characters; no digits. */
export function cleanLabel(raw: string): string | null {
  const label = raw.trim().replace(/\s+/g, ' ');
  if (label.length < 1 || label.length > 20) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(label) ? label : null;
}

export interface CaregiverLookup {
  id: string;
  userId: string;
  status: 'pending' | 'verified';
  invitedAt: Date;
}

export type AddCheck = 'ok' | 'invalid_number' | 'own_number' | 'limit' | 'already';

export type CaregiverAlertOutcome = 'sent' | 'no_caregiver' | 'throttled';

const GENERIC_REENGAGE: TemplateContent = {
  kind: 'template',
  template: 'generic_reengage',
  language: 'hi',
};

/**
 * Family contacts (F5) with consent from BOTH sides: the user adds a number and a name, the caregiver
 * must reply YES to a template message, and only then can an alert be sent. Alerts carry a label and
 * a time only: never a medicine name or any health detail (minimum necessary information).
 */
@Injectable()
export class CaregiversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly outbound: OutboundService,
    private readonly i18n: I18nService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.logger.setContext(CaregiversService.name);
  }

  // ------------------------------------------------------------------ add flow (user side)

  /** Validate a typed number against the rules before asking for the label. */
  async checkNewNumber(
    userId: string,
    rawNumber: string,
  ): Promise<{ result: AddCheck; hash?: string }> {
    let normalised: string;
    try {
      normalised = this.crypto.normalisePhone(rawNumber);
    } catch {
      return { result: 'invalid_number' };
    }
    if (!isIndianMobile(normalised)) return { result: 'invalid_number' };
    const hash = this.crypto.hashPhone(normalised);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { waPhoneHash: true },
    });
    if (user?.waPhoneHash === hash) return { result: 'own_number' };

    const rows = await this.prisma.caregiver.findMany({
      where: { userId, status: { in: ['pending', 'verified'] } },
      select: { waPhoneHash: true },
    });
    if (rows.some((row) => row.waPhoneHash === hash)) return { result: 'already' };
    if (rows.length >= MAX_ACTIVE_CAREGIVERS) return { result: 'limit' };
    return { result: 'ok', hash };
  }

  /** Create (or re-open) the caregiver row and send the invite template. */
  async invite(
    userId: string,
    language: Language,
    rawNumber: string,
    label: string,
    sourceMessageId: string,
    now: Date = new Date(),
  ): Promise<{ caregiverId: string } | null> {
    const check = await this.checkNewNumber(userId, rawNumber);
    if (check.result !== 'ok' || !check.hash) return null;
    const normalised = this.crypto.normalisePhone(rawNumber);

    const caregiver = await this.prisma.caregiver.upsert({
      where: { userId_waPhoneHash: { userId, waPhoneHash: check.hash } },
      create: {
        userId,
        waPhoneHash: check.hash,
        waPhoneEnc: this.crypto.encrypt(normalised),
        relation: label,
        status: 'pending',
        invitedAt: now,
      },
      // A person who declined, expired or was removed can be invited again.
      update: {
        waPhoneEnc: this.crypto.encrypt(normalised),
        relation: label,
        status: 'pending',
        invitedAt: now,
        verifiedAt: null,
        lastAlertAt: null,
        alertsToday: 0,
        alertsDay: null,
      },
      select: { id: true },
    });
    await this.outbound.enqueue(userId, {
      content: {
        kind: 'template',
        template: 'caregiver_invite',
        language,
        params: { user_label: label },
      },
      sourceMessageId,
      replyIndex: 50,
      recipient: { caregiverId: caregiver.id },
    });
    await this.audit.log({ actor: 'user', userId, action: 'caregiver_invited' });
    return { caregiverId: caregiver.id };
  }

  async remove(userId: string): Promise<number> {
    const result = await this.prisma.caregiver.updateMany({
      where: { userId, status: { in: ['pending', 'verified'] } },
      data: { status: 'removed' },
    });
    if (result.count > 0) {
      await this.audit.log({
        actor: 'user',
        userId,
        action: 'caregiver_removed',
        metadata: { count: result.count },
      });
    }
    return result.count;
  }

  async summary(userId: string): Promise<{ verified: number; pending: number }> {
    const rows = await this.prisma.caregiver.groupBy({
      by: ['status'],
      where: { userId, status: { in: ['pending', 'verified'] } },
      _count: { _all: true },
    });
    const count = (status: string): number =>
      rows.find((row) => row.status === status)?._count._all ?? 0;
    return { verified: count('verified'), pending: count('pending') };
  }

  // ------------------------------------------------------------------ caregiver side

  /** Called by the webhook: which caregiver rows does this phone belong to? */
  async findByPhone(phone: string): Promise<CaregiverLookup[]> {
    const hash = this.crypto.hashPhone(phone);
    const rows = await this.prisma.caregiver.findMany({
      where: { waPhoneHash: hash, status: { in: ['pending', 'verified'] } },
      select: { id: true, userId: true, status: true, invitedAt: true },
    });
    return rows.map((row) => ({
      ...row,
      status: row.status === 'verified' ? 'verified' : 'pending',
    }));
  }

  async touchInbound(caregiverIds: readonly string[], at: Date): Promise<void> {
    await this.prisma.caregiver.updateMany({
      where: {
        id: { in: [...caregiverIds] },
        OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }],
      },
      data: { lastInboundAt: at },
    });
  }

  /** Worker: apply YES / NO / STOP ALERTS from one caregiver to one patient's row. */
  async handleReply(job: CaregiverReplyJobData, now: Date = new Date()): Promise<string> {
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { id: job.caregiverId },
      select: { id: true, userId: true, status: true, invitedAt: true, relation: true },
    });
    if (!caregiver || caregiver.userId !== job.userId) return 'gone';
    const language = await this.userLanguage(caregiver.userId);
    const notifyCaregiver = (key: MessageKey, params: Record<string, string> = {}): Promise<void> =>
      this.sendTextToCaregiver(
        caregiver.userId,
        caregiver.id,
        language,
        key,
        job.waMessageId,
        params,
      );

    if (job.reply === 'stop_alerts') {
      if (caregiver.status === 'removed' || caregiver.status === 'declined') return 'noop';
      await this.prisma.caregiver.update({
        where: { id: caregiver.id },
        data: { status: 'removed' },
      });
      await this.audit.log({
        actor: 'user',
        userId: caregiver.userId,
        action: 'caregiver_removed',
        metadata: { by_caregiver: true },
      });
      await notifyCaregiver('caregiver.cg_stopped');
      await this.notifyUser(
        caregiver.userId,
        language,
        'caregiver.user_stopped',
        `cgs_${caregiver.id}`,
      );
      return 'stopped';
    }

    if (caregiver.status !== 'pending') return 'noop';
    if (now.getTime() - caregiver.invitedAt.getTime() > INVITE_TTL_MS) {
      await this.prisma.caregiver.update({
        where: { id: caregiver.id },
        data: { status: 'declined' },
      });
      await notifyCaregiver('caregiver.cg_expired');
      await this.notifyUser(
        caregiver.userId,
        language,
        'caregiver.user_expired',
        `cge_${caregiver.id}`,
      );
      return 'expired';
    }

    if (job.reply === 'yes') {
      const updated = await this.prisma.caregiver.updateMany({
        where: { id: caregiver.id, status: 'pending' },
        data: { status: 'verified', verifiedAt: now },
      });
      if (updated.count === 0) return 'noop';
      await this.audit.log({
        actor: 'user',
        userId: caregiver.userId,
        action: 'caregiver_verified',
      });
      await notifyCaregiver('caregiver.cg_verified', { label: caregiver.relation });
      await this.notifyUser(
        caregiver.userId,
        language,
        'caregiver.user_verified',
        `cgv_${caregiver.id}`,
      );
      return 'verified';
    }

    const updated = await this.prisma.caregiver.updateMany({
      where: { id: caregiver.id, status: 'pending' },
      data: { status: 'declined' },
    });
    if (updated.count === 0) return 'noop';
    await this.audit.log({ actor: 'user', userId: caregiver.userId, action: 'caregiver_declined' });
    await notifyCaregiver('caregiver.cg_declined');
    await this.notifyUser(
      caregiver.userId,
      language,
      'caregiver.user_declined',
      `cgd_${caregiver.id}`,
    );
    return 'declined';
  }

  /** Worker (every 5 min): invites older than 48 h become `declined` and the user is told. */
  async expireInvites(now: Date = new Date()): Promise<number> {
    const stale = await this.prisma.caregiver.findMany({
      where: { status: 'pending', invitedAt: { lt: new Date(now.getTime() - INVITE_TTL_MS) } },
      select: { id: true, userId: true },
      take: 200,
    });
    let expired = 0;
    for (const caregiver of stale) {
      const updated = await this.prisma.caregiver.updateMany({
        where: { id: caregiver.id, status: 'pending' },
        data: { status: 'declined' },
      });
      if (updated.count === 0) continue;
      expired += 1;
      await this.audit.log({
        actor: 'system',
        userId: caregiver.userId,
        action: 'caregiver_declined',
        metadata: { expired: true },
      });
      const language = await this.userLanguage(caregiver.userId);
      await this.notifyUser(
        caregiver.userId,
        language,
        'caregiver.user_expired',
        `cge_${caregiver.id}`,
      );
    }
    return expired;
  }

  // ------------------------------------------------------------------ alerts

  /**
   * "{{user_label}} did not take the {{time}} dose (twice in a row)". Label and time only. At most one
   * alert per caregiver per 6 hours and three per local day.
   */
  async alertMissedDose(
    userId: string,
    slot: Date,
    now: Date = new Date(),
  ): Promise<{ outcome: CaregiverAlertOutcome; sent: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { language: true, timezone: true, deletedAt: true },
    });
    if (!user || user.deletedAt) return { outcome: 'no_caregiver', sent: 0 };
    const caregivers = await this.prisma.caregiver.findMany({
      where: { userId, status: 'verified' },
      select: { id: true, relation: true, lastAlertAt: true, alertsToday: true, alertsDay: true },
    });
    if (caregivers.length === 0) return { outcome: 'no_caregiver', sent: 0 };

    const today = localDateOf(now, user.timezone);
    let sent = 0;
    for (const caregiver of caregivers) {
      const sinceLast = caregiver.lastAlertAt
        ? now.getTime() - caregiver.lastAlertAt.getTime()
        : Infinity;
      const todayCount =
        caregiver.alertsDay && isoDate(caregiver.alertsDay) === today ? caregiver.alertsToday : 0;
      if (sinceLast < ALERT_MIN_GAP_MS || todayCount >= MAX_ALERTS_PER_DAY) continue;

      // Claim the alert slot conditionally so two workers cannot both send.
      const claimed = await this.prisma.caregiver.updateMany({
        where: {
          id: caregiver.id,
          status: 'verified',
          lastAlertAt: caregiver.lastAlertAt === null ? null : caregiver.lastAlertAt,
        },
        data: {
          lastAlertAt: now,
          alertsToday: todayCount + 1,
          alertsDay: new Date(`${today}T00:00:00.000Z`),
        },
      });
      if (claimed.count === 0) continue;
      await this.outbound.enqueue(userId, {
        content: {
          kind: 'template',
          template: 'caregiver_missed_dose_alert',
          language: user.language,
          // NOTHING else goes in: no medicine, no dose, no condition.
          params: { user_label: caregiver.relation, time: localTimeOf(slot, user.timezone) },
        },
        sourceMessageId: `cga_${caregiver.id}_${epochSeconds(slot)}`,
        replyIndex: 0,
        recipient: { caregiverId: caregiver.id },
      });
      this.metrics?.caregiverAlerts.inc();
      await this.audit.log({ actor: 'system', userId, action: 'caregiver_alert_sent' });
      sent += 1;
    }
    return { outcome: sent > 0 ? 'sent' : 'throttled', sent };
  }

  // ------------------------------------------------------------------ helpers

  private async userLanguage(userId: string): Promise<Language> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { language: true },
    });
    return user?.language ?? 'hi';
  }

  private async sendTextToCaregiver(
    userId: string,
    caregiverId: string,
    language: Language,
    key: MessageKey,
    sourceMessageId: string,
    params: Record<string, string>,
  ): Promise<void> {
    // The caregiver just wrote to us, so their 24 h window is open.
    await this.outbound.enqueue(userId, {
      content: { kind: 'text', body: this.i18n.t(language, key, params) },
      sourceMessageId: `cgr_${sourceMessageId}`,
      replyIndex: 0,
      recipient: { caregiverId },
    });
  }

  /** A note to the patient: free text in the 24 h window, else the re-engage template. */
  private async notifyUser(
    userId: string,
    language: Language,
    key: MessageKey,
    sourceMessageId: string,
  ): Promise<void> {
    try {
      await this.outbound.enqueue(userId, {
        content: { kind: 'text', body: this.i18n.t(language, key) },
        templateFallback: { ...GENERIC_REENGAGE, language },
        sourceMessageId,
        replyIndex: 0,
      });
    } catch (error) {
      this.logger.warn(
        { user_id: userId, error: (error as Error).name },
        'caregiver note to user failed',
      );
    }
  }
}
