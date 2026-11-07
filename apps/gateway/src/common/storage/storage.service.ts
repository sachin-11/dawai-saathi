import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';

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

  constructor(@Inject(APP_CONFIG) env: Env) {
    this.bucket = env.S3_BUCKET;
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

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
