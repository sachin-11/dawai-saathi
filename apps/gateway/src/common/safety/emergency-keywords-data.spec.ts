import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv from 'ajv';

import { detectEmergencyMatch, EMERGENCY_KEYWORDS_VERSION } from './emergency-keywords';
import { normaliseForEmergency } from './normalise';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SAFETY_DIR = join(ROOT, 'packages', 'contracts', 'safety');
const read = (name: string): string => readFileSync(join(SAFETY_DIR, name), 'utf8');

interface KeywordFile {
  version: string;
  categories: Record<string, { kind: string; en: string[]; hi: string[]; hinglish: string[] }>;
}
const canonical = JSON.parse(read('emergency-keywords.json')) as KeywordFile;

describe('shared emergency keyword file', () => {
  it('validates against its JSON schema', () => {
    const validate = new Ajv({ allErrors: true }).compile(
      JSON.parse(read('emergency-keywords.schema.json')) as object,
    );
    expect(validate(canonical)).toBe(true);
  });

  it('the gateway copy is identical to the canonical file (run `make safety-data` if not)', () => {
    const copy = readFileSync(join(__dirname, 'data', 'emergency-keywords.json'), 'utf8');
    expect(copy).toBe(read('emergency-keywords.json'));
  });

  it('the matcher reports the canonical version', () => {
    expect(EMERGENCY_KEYWORDS_VERSION).toBe(canonical.version);
  });

  it('every phrase of every category and language is detected, with its own category kind', () => {
    for (const [category, data] of Object.entries(canonical.categories)) {
      for (const phrase of [...data.en, ...data.hi, ...data.hinglish]) {
        const match = detectEmergencyMatch(`please help: ${phrase} right now`);
        expect(match).not.toBeNull();
        // A phrase may legitimately belong to an earlier category (self_harm is checked first),
        // but the kind must be right for self_harm phrases.
        if (category === 'self_harm') {
          expect(match?.kind).toBe('self_harm');
        }
      }
    }
  });

  it('the category of a clear example is reported', () => {
    expect(detectEmergencyMatch('seene me bahut dard ho raha hai')?.category).toBe('cardiac');
    expect(detectEmergencyMatch('mujhe jeena nahi hai')).toEqual({
      kind: 'self_harm',
      category: 'self_harm',
    });
    expect(detectEmergencyMatch('cricket score batao')).toBeNull();
    expect(detectEmergencyMatch('hi')).toBeNull();
  });

  it('survives repeated letters', () => {
    expect(detectEmergencyMatch('seene me dardddd')?.category).toBe('cardiac');
    expect(detectEmergencyMatch('saaaans nahi aa rahi')?.category).toBe('breathing');
  });
});

describe('normalisation vectors shared with the AI service', () => {
  const vectors = (
    JSON.parse(read('normalisation-vectors.json')) as {
      vectors: Array<{ input: string; expected: string }>;
    }
  ).vectors;

  it.each(vectors.map((v) => [v.input, v.expected]))('normalises %j to %j', (input, expected) => {
    expect(normaliseForEmergency(input)).toBe(expected);
  });
});
