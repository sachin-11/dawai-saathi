import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEGAL } from '@/content/legal';
import en from '@/messages/en.json';
import hi from '@/messages/hi.json';

/** Every leaf path, with list length encoded so a missing list item is caught too. */
function shape(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return [
      `${prefix}[${value.length}]`,
      ...value.flatMap((item, i) => shape(item, `${prefix}[${i}]`)),
    ];
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => shape(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

function leaves(value: unknown, prefix = ''): [string, string][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${prefix}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, String(value)]];
}

describe('message catalogues', () => {
  it('hi and en have exactly the same keys and list lengths', () => {
    expect(shape(hi).sort()).toEqual(shape(en).sort());
  });

  it('has no empty strings and keeps ICU placeholders in both languages', () => {
    for (const [path, text] of [...leaves(en), ...leaves(hi)]) {
      expect(text.trim(), path).not.toBe('');
    }
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const enMap = new Map(leaves(en));
    for (const [path, text] of leaves(hi)) {
      expect(placeholders(text).sort(), path).toEqual(placeholders(enMap.get(path) ?? '').sort());
    }
  });

  it('the Hindi catalogue is really Devanagari, not a copy of English', () => {
    expect(hi.hero.title).toMatch(/[ऀ-ॿ]/);
    expect(hi.hero.title).not.toBe(en.hero.title);
  });
});

describe('legal pages', () => {
  it('privacy and terms have the same sections in hi and en', () => {
    for (const kind of ['privacy', 'terms'] as const) {
      expect(LEGAL[kind].hi.sections.map((s) => s.id)).toEqual(
        LEGAL[kind].en.sections.map((s) => s.id),
      );
      for (const locale of ['hi', 'en'] as const) {
        expect(LEGAL[kind][locale].draftBanner.length).toBeGreaterThan(20);
      }
    }
  });

  it('is marked as a draft that needs legal review (comment in the source)', () => {
    const source = readFileSync(join(__dirname, '..', 'content', 'legal.ts'), 'utf-8');
    expect(source).toMatch(/DRAFT/);
    expect(source).toMatch(/lawyer/i);
  });

  it('privacy names the real processors and the DELETE command', () => {
    const text = JSON.stringify(LEGAL.privacy.en);
    for (const word of ['Meta', 'Anthropic', 'OpenAI', 'Mumbai', 'DELETE', 'DPDP', '30 days']) {
      expect(text).toContain(word);
    }
  });
});
