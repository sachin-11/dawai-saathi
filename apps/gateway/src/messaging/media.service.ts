import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { StorageService } from '../common/storage/storage.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { MessagesService } from './messages.service';
import { WhatsAppClient } from './whatsapp.client';

/** Only these types are downloaded: prescription/report photos, PDFs and voice notes. */
export const ALLOWED_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf'],
  ['audio/ogg', 'ogg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/aac', 'aac'],
]);

/** `audio/ogg; codecs=opus` (what voice notes report) -> `audio/ogg`. */
export function normaliseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * S3 key for an inbound file: `media/<userId>/<yyyy>/<mm>/<messageId>.<ext>`.
 * Only internal UUIDs and a fixed extension: no phone number and no user-supplied filename
 * (a filename like `Ramesh_Sharma_Rx.pdf` would put PII into the key, which also ends up in logs).
 */
export function buildMediaKey(input: {
  userId: string;
  messageId: string;
  extension: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `media/${input.userId}/${year}/${month}/${input.messageId}.${input.extension}`;
}

export class MediaTooLargeError extends Error {
  constructor() {
    super('media exceeds the size limit');
    this.name = 'MediaTooLargeError';
  }
}

/** The downloaded bytes do not match the hash Meta announced: corrupt or tampered. */
export class MediaIntegrityError extends Error {
  constructor() {
    super('media sha256 does not match');
    this.name = 'MediaIntegrityError';
  }
}

/**
 * Pass-through stream that counts bytes, hashes them and aborts once the limit is crossed, so a
 * lying `Content-Length` (or none at all) can never make us store more than `maxBytes`.
 */
export function createLimitedHashStream(maxBytes: number): {
  stream: Transform;
  bytes: () => number;
  exceeded: () => boolean;
  digest: () => { hex: string; base64: string };
} {
  const hash = createHash('sha256');
  let bytes = 0;
  let exceeded = false;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback): void {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        exceeded = true;
        callback(new MediaTooLargeError());
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    stream,
    bytes: () => bytes,
    exceeded: () => exceeded,
    digest: () => {
      const digest = hash.copy().digest();
      return { hex: digest.toString('hex'), base64: digest.toString('base64') };
    },
  };
}

export type MediaResult =
  | { status: 'stored'; key: string; bytes: number; mimeType: string }
  | { status: 'rejected'; reason: 'unsupported_type' | 'too_large' };

@Injectable()
export class MediaService {
  private readonly maxBytes: number;

  constructor(
    @Inject(APP_CONFIG) env: Env,
    private readonly client: WhatsAppClient,
    private readonly storage: StorageService,
    private readonly messages: MessagesService,
    private readonly logger: PinoLogger,
  ) {
    this.maxBytes = env.MAX_MEDIA_MB * 1024 * 1024;
    this.logger.setContext(MediaService.name);
  }

  /**
   * Download an inbound WhatsApp media file and store it in S3.
   *
   * Expected refusals (wrong type, too big) are returned as `{ status: 'rejected' }` so the caller
   * can reply politely; real failures (network, S3, hash mismatch) throw and the job is retried.
   * The file is streamed Meta -> size/hash guard -> S3 and never held in memory as a whole.
   */
  async storeInboundMedia(input: {
    messageId: string;
    userId: string;
    mediaId: string;
    requestId?: string;
  }): Promise<MediaResult> {
    const options = input.requestId ? { requestId: input.requestId } : {};

    const info = await this.client.getMediaUrl(input.mediaId, options);
    const mimeType = normaliseMimeType(info.mimeType);
    const extension = ALLOWED_MEDIA_TYPES.get(mimeType);
    if (!extension) {
      this.logger.info({ mime_type: mimeType }, 'inbound media rejected: type not allowed');
      return { status: 'rejected', reason: 'unsupported_type' };
    }
    if (info.fileSize !== undefined && info.fileSize > this.maxBytes) {
      this.logger.info({ file_size: info.fileSize }, 'inbound media rejected: too large');
      return { status: 'rejected', reason: 'too_large' };
    }

    // The URL expires quickly: download straight away.
    const download = await this.client.downloadMedia(info.url, options);
    if (download.contentLength !== undefined && download.contentLength > this.maxBytes) {
      download.stream.destroy();
      return { status: 'rejected', reason: 'too_large' };
    }

    const key = buildMediaKey({ userId: input.userId, messageId: input.messageId, extension });
    const guard = createLimitedHashStream(this.maxBytes);
    download.stream.on('error', (error) => guard.stream.destroy(error));
    download.stream.pipe(guard.stream);

    try {
      await this.storage.putStream({ key, body: guard.stream, contentType: mimeType });
    } catch (error) {
      download.stream.destroy();
      if (guard.exceeded()) {
        this.logger.info('inbound media rejected: exceeded size limit while streaming');
        return { status: 'rejected', reason: 'too_large' };
      }
      throw error;
    }

    if (info.sha256) {
      const { hex, base64 } = guard.digest();
      if (info.sha256 !== hex && info.sha256 !== base64) {
        await this.storage.deleteObject(key);
        throw new MediaIntegrityError();
      }
    }

    await this.messages.setMediaKey(input.messageId, key);
    this.logger.info({ bytes: guard.bytes(), mime_type: mimeType }, 'inbound media stored');
    return { status: 'stored', key, bytes: guard.bytes(), mimeType };
  }
}
