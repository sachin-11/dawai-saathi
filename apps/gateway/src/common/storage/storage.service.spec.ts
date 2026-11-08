import type { Env } from '../../config/env.schema';
import { StorageService } from './storage.service';

const env = (overrides: Partial<Env> = {}): Env =>
  ({
    S3_BUCKET: 'dawai-media',
    S3_SSE: 'AES256',
    AWS_REGION: 'ap-south-1',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    ...overrides,
  }) as Env;

describe('StorageService.getPresignedUrl', () => {
  it('signs for S3_ENDPOINT by default', async () => {
    const storage = new StorageService(env());
    const url = await storage.getPresignedUrl('media/u/a.jpg', 300);
    expect(url.startsWith('http://localhost:9000/dawai-media/media/u/a.jpg?')).toBe(true);
    expect(url).toContain('X-Amz-Expires=300');
    expect(url).toContain('X-Amz-Signature=');
    storage.onModuleDestroy();
  });

  it('signs for S3_AI_ENDPOINT when the AI service reaches S3 under another hostname', async () => {
    const storage = new StorageService(env({ S3_AI_ENDPOINT: 'http://minio:9000' }));
    const url = await storage.getPresignedUrl('media/u/a.jpg');
    expect(url.startsWith('http://minio:9000/dawai-media/media/u/a.jpg?')).toBe(true);
    storage.onModuleDestroy();
  });
});
