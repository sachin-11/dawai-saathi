import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import type { ProcessResponse } from '../ai-client/types';
import {
  DEMO_LANGUAGES,
  DEMO_SAMPLE_IDS,
  type DemoLanguage,
  type DemoSampleId,
} from './demo.constants';

/** Where `make demo-cache` writes (shipped with the image: package.json `files`). */
export const DEMO_CACHE_DIR = join(__dirname, '..', '..', 'demo-cache');

export type CachedDemoResponse = Pick<
  ProcessResponse,
  'intent' | 'extraction' | 'warnings' | 'reply' | 'debug_trace' | 'meta' | 'interactions'
>;

export function isSampleId(value: unknown): value is DemoSampleId {
  return typeof value === 'string' && (DEMO_SAMPLE_IDS as readonly string[]).includes(value);
}

export function isDemoLanguage(value: unknown): value is DemoLanguage {
  return typeof value === 'string' && (DEMO_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Pre-computed answers for each bundled sample and language. They are the reason samples keep
 * working when the demo budget is spent, and they cost nothing. A sample is only ever served from
 * here (the gateway holds no sample image), so the demo can never be made to spend money on a sample.
 */
@Injectable()
export class DemoCacheService {
  private readonly dir: string = DEMO_CACHE_DIR;

  async get(sample: DemoSampleId, language: DemoLanguage): Promise<CachedDemoResponse | null> {
    try {
      const raw = await readFile(join(this.dir, `${sample}.${language}.json`), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CachedDemoResponse> | null;
      return typeof parsed?.reply?.text === 'string' ? (parsed as CachedDemoResponse) : null;
    } catch {
      return null;
    }
  }

  async available(): Promise<{ id: DemoSampleId; languages: DemoLanguage[] }[]> {
    const rows = await Promise.all(
      DEMO_SAMPLE_IDS.map(async (id) => ({
        id,
        languages: (
          await Promise.all(
            DEMO_LANGUAGES.map(async (language) =>
              (await this.get(id, language)) ? language : null,
            ),
          )
        ).filter((language): language is DemoLanguage => language !== null),
      })),
    );
    return rows.filter((row) => row.languages.length > 0);
  }
}
