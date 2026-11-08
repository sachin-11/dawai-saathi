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
  | 'reminders_scheduled'
  | 'caregiver_invited'
  | 'caregiver_verified'
  | 'caregiver_declined'
  | 'caregiver_removed'
  | 'caregiver_alert_sent'
  | 'user_deleted';

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

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
