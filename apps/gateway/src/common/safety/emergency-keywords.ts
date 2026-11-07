import keywordData from './data/emergency-keywords.json';
import { normaliseForEmergency } from './normalise';

export type EmergencyKind = 'general' | 'self_harm';

export type EmergencyCategory =
  | 'cardiac'
  | 'breathing'
  | 'unconscious'
  | 'bleeding'
  | 'poisoning_overdose'
  | 'seizure'
  | 'stroke'
  | 'severe_allergy'
  | 'self_harm';

interface CategoryData {
  kind: EmergencyKind;
  en: string[];
  hi: string[];
  hinglish: string[];
  misspellings: string[];
}

/**
 * Always-on safety net (CLAUDE.md section 2.2). This runs in the gateway for EVERY message of EVERY
 * user, before consent, before any LLM, and works even when the AI service is down.
 *
 * The phrases come from ONE shared file, `packages/contracts/safety/emergency-keywords.json`
 * (copied into this app by `make safety-data`; a test fails when the copy is stale). The AI service
 * reads the same file and adds fuzzy matching and an LLM classifier on top.
 *
 * It is deliberately safety-first: it matches phrases anywhere in the text, so "no chest pain" or
 * "chest pain ki dawai kaunsi hai" also trigger it. A needless "call 112" is far cheaper than a
 * missed emergency. Voice notes are not covered until speech-to-text exists (M13).
 */
export const EMERGENCY_KEYWORDS_VERSION: string = keywordData.version;

/** Up to this many other words may sit BETWEEN the words of a phrase ("seene me BAHUT dard"). */
export const MAX_PHRASE_GAP = 2;

interface Keyword {
  /** The phrase split into normalised words. */
  tokens: string[];
  /** Per word: Latin words must match exactly (so "poison" does not match "poisonous"); Devanagari words match as a prefix because matras and suffixes attach to the stem. */
  latin: boolean[];
}

function compile(phrases: readonly string[]): Keyword[] {
  const unique = new Set(phrases.map(normaliseForEmergency).filter((phrase) => phrase.length > 0));
  return [...unique].map((phrase) => {
    const tokens = phrase.split(' ');
    return { tokens, latin: tokens.map((token) => /^[a-z0-9]/.test(token)) };
  });
}

function tokenMatches(word: string, keywordToken: string, latin: boolean): boolean {
  return latin ? word === keywordToken : word.startsWith(keywordToken);
}

function matchesPhrase(words: readonly string[], keyword: Keyword): boolean {
  const { tokens, latin } = keyword;
  for (let start = 0; start < words.length; start++) {
    if (!tokenMatches(words[start] ?? '', tokens[0] ?? '', latin[0] ?? true)) continue;
    let position = start;
    let matched = 1;
    while (matched < tokens.length) {
      let found = -1;
      for (let next = position + 1; next <= position + 1 + MAX_PHRASE_GAP; next++) {
        if (
          next < words.length &&
          tokenMatches(words[next] ?? '', tokens[matched] ?? '', latin[matched] ?? true)
        ) {
          found = next;
          break;
        }
      }
      if (found < 0) break;
      position = found;
      matched++;
    }
    if (matched === tokens.length) return true;
  }
  return false;
}

interface CompiledCategory {
  category: EmergencyCategory;
  kind: EmergencyKind;
  keywords: Keyword[];
}

const CATEGORIES: readonly CompiledCategory[] = (
  Object.entries(keywordData.categories) as Array<[EmergencyCategory, CategoryData]>
).map(([category, data]) => ({
  category,
  kind: data.kind,
  keywords: compile([...data.en, ...data.hi, ...data.hinglish, ...data.misspellings]),
}));

// self_harm is checked first: it adds Tele-MANAS 14416 to the reply.
const ORDERED: readonly CompiledCategory[] = [
  ...CATEGORIES.filter((entry) => entry.kind === 'self_harm'),
  ...CATEGORIES.filter((entry) => entry.kind !== 'self_harm'),
];

function matchesAny(normalised: string, keywords: readonly Keyword[]): boolean {
  const words = normalised.split(' ');
  return keywords.some((keyword) => matchesPhrase(words, keyword));
}

export interface EmergencyMatch {
  kind: EmergencyKind;
  category: EmergencyCategory;
}

/** Like `detectEmergency` but also says which category matched (no text is returned). */
export function detectEmergencyMatch(text: string): EmergencyMatch | null {
  const normalised = normaliseForEmergency(text);
  if (normalised.length === 0) {
    return null;
  }
  for (const entry of ORDERED) {
    if (matchesAny(normalised, entry.keywords)) {
      return { kind: entry.kind, category: entry.category };
    }
  }
  return null;
}

/**
 * Does this message look like an emergency? `self_harm` wins over `general` (it adds Tele-MANAS
 * 14416 to the reply). Returns null for blank text or no match.
 */
export function detectEmergency(text: string): EmergencyKind | null {
  return detectEmergencyMatch(text)?.kind ?? null;
}
