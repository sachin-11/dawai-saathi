import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Readable } from 'node:stream';

import { APP_CONFIG } from '../../config/config.constants';
import type { Env } from '../../config/env.schema';

/**
 * S3 access. Locally this talks to MinIO (`S3_ENDPOINT` set, path-style URLs, static keys);
 * on AWS `S3_ENDPOINT` is empty and credentials come from the task IAM role.
 * M1 only needs `healthCheck`; upload/download/presign arrive with M3 (media) and M4 (DELETE).
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  readonly client: S3Client;
  readonly bucket: string;
  private readonly sse: Env['S3_SSE'];

  constructor(@Inject(APP_CONFIG) env: Env) {
    this.bucket = env.S3_BUCKET;
    this.sse = env.S3_SSE;
    this.client = new S3Client({
      region: env.AWS_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
      // Health checks must not hide behind SDK retries.
      maxAttempts: 2,
    });
  }

  /** HeadBucket: proves endpoint, credentials and bucket all work. Throws otherwise. */
  async healthCheck(signal?: AbortSignal): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      ...(signal ? { abortSignal: signal } : {}),
    });
  }

  /**
   * Stream `body` into S3 without holding the whole file in memory (multipart upload in 5 MB
   * parts). Server-side encryption is on unless explicitly disabled for a local MinIO without KMS.
   * If the stream errors, the multipart upload is aborted and nothing is left behind.
   */
  async putStream(input: { key: string; body: Readable; contentType: string }): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ...(this.sse === 'AES256' ? { ServerSideEncryption: 'AES256' as const } : {}),
      },
      queueSize: 2,
      partSize: 5 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  /** Time-limited GET URL (default 5 minutes) so the AI service can fetch a file without credentials. */
  getPresignedUrl(key: string, ttlSeconds = 300): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Delete every object under `prefix` (used by the DELETE command, M4: `media/<userId>/`).
   * The prefix must end with "/" so a short prefix can never wipe unrelated keys or the whole bucket.
   * Returns the number of objects deleted.
   */
  async deletePrefix(prefix: string): Promise<number> {
    if (prefix.length < 2 || !prefix.endsWith('/')) {
      throw new Error('deletePrefix requires a non-empty prefix that ends with "/"');
    }
    let deleted = 0;
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      const keys = (page.Contents ?? []).flatMap((object) =>
        object.Key ? [{ Key: object.Key }] : [],
      );
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        deleted += keys.length;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return deleted;
  }

  /** Metadata of a stored object (size, content type, encryption), or undefined if it does not exist. */
  async statObject(
    key: string,
  ): Promise<
    | { contentLength: number; contentType: string | undefined; encryption: string | undefined }
    | undefined
  > {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
        encryption: head.ServerSideEncryption,
      };
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') {
        return undefined;
      }
      throw error;
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
