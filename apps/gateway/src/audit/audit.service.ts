import { Global, Injectable, Module } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { redactText } from '../common/redaction/redact';

export type AuditActor = 'user' | 'system' | 'admin';

export type AuditAction =
  | 'consent_given'
  | 'consent_declined'
  | 'language_changed'
  | 'reminders_disabled'
  | 'reminders_enabled'
  | 'delete_requested'
  | 'emergency_detected'
  | 'rx_reported_wrong'
  | 'lab_reported_wrong'
  | 'reminders_scheduled'
  | 'caregiver_invited'
  | 'caregiver_verified'
  | 'caregiver_declined'
  | 'caregiver_removed'
  | 'caregiver_alert_sent'
  | 'consent_updated'
  | 'voice_replies_enabled'
  | 'voice_replies_disabled'
  | 'user_deleted'
  | 'user_blocked'
  | 'user_unblocked'
  | 'dlq_retry'
  | 'dlq_purge'
  | 'admin_reveal'
  | 'admin_review_resolved'
  | 'admin_dlq_retry'
  | 'admin_login_denied';

export type AuditValue =
  string | number | boolean | null | AuditValue[] | { [key: string]: AuditValue };
export type AuditMetadata = Record<string, AuditValue>;

export class AuditMetadataError extends Error {
  constructor(path: string) {
    // Never echo the offending value: it may be exactly the PII we are guarding against.
    super(`audit metadata is not allowed at "${path}"`);
    this.name = 'AuditMetadataError';
  }
}

const SAFE_KEY = /^[a-z][a-z0-9_]{0,40}$/;
/** Short machine tokens only: "hi", "v1", "consent_given". No spaces, so no sentences, names or free text. */
const SAFE_STRING = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const MAX_DEPTH = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Audit metadata may only contain numbers, booleans, null, short machine tokens and nested
 * objects/arrays of those. It can therefore never carry a phone number, an email, a name or message
 * text (CLAUDE.md §2.6, §12). A token that LOOKS like an identifier (10-digit mobile, 12-digit
 * Aadhaar-like, 6-digit PIN) is rejected too, even though it matches the token pattern.
 */
export function assertSafeAuditMetadata(value: unknown, path = 'metadata', depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new AuditMetadataError(path);
  }
  if (value === null || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AuditMetadataError(path);
    }
    return;
  }
  if (typeof value === 'string') {
    // A canonical uuid is an opaque id, not PII. (A random uuid whose last 12 characters are all digits
    // would otherwise look like an Aadhaar-like number to the redactor and block an audit write.)
    if (UUID.test(value)) return;
    if (!SAFE_STRING.test(value) || redactText(value) !== value) {
      throw new AuditMetadataError(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertSafeAuditMetadata(item, `${path}[${index}]`, depth + 1);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!SAFE_KEY.test(key)) {
        throw new AuditMetadataError(`${path}.${key}`);
      }
      assertSafeAuditMetadata(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new AuditMetadataError(path);
}

export interface AuditEntry {
  actor: AuditActor;
  /** Null for anonymous entries such as `user_deleted`. */
  userId: string | null;
  action: AuditAction;
  metadata?: AuditMetadata;
}

/** Append-only audit trail for consent, language, reminders and erasure (CLAUDE.md §12). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * M16: operator actions. The operator is not a patient, so the audit trail names them (e-mail) and, for
   * revealing a document, records the stated reason. Everything else in `metadata` still has to be a
   * machine token, and the reason is run through the same redaction as stored messages.
   */
  async logAdmin(entry: AdminAuditEntry): Promise<void> {
    const metadata = entry.metadata ?? {};
    assertSafeAuditMetadata(metadata);
    if (!ADMIN_EMAIL.test(entry.adminEmail)) throw new AuditMetadataError('admin_email');
    const reason =
      entry.reason === undefined
        ? undefined
        : redactText(entry.reason.trim()).slice(0, ADMIN_REASON_MAX);
    await this.prisma.auditLog.create({
      data: {
        actor: 'admin',
        userId: entry.userId ?? null,
        action: entry.action,
        metadata: {
          ...metadata,
          admin_email: entry.adminEmail.toLowerCase(),
          ...(reason ? { reason } : {}),
        },
      },
    });
  }

  async log(entry: AuditEntry): Promise<void> {
    const metadata = entry.metadata ?? {};
    assertSafeAuditMetadata(metadata);
    await this.prisma.auditLog.create({
      data: {
        actor: entry.actor,
        userId: entry.userId,
        action: entry.action,
        metadata,
      },
    });
  }
}

/** A well-formed e-mail: the only free-form identity an admin audit row may carry. */
const ADMIN_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
export const ADMIN_REASON_MAX = 300;

export interface AdminAuditEntry {
  action: Extract<AuditAction, `admin_${string}`>;
  /** The operator (already checked against the allowlist). */
  adminEmail: string;
  /** The patient the action concerns (uuid), if any. */
  userId?: string | null;
  /** Machine tokens only (document id, label, queue ...): validated like every audit row. */
  metadata?: AuditMetadata;
  /** Why the operator looked at PHI. Free text typed by an operator, so identifiers are redacted and it is length-capped. */
  reason?: string;
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
