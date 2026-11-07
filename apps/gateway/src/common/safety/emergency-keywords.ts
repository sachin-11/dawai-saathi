import { normaliseForMatching } from './normalise';

export type EmergencyKind = 'general' | 'self_harm';

/**
 * Always-on safety net (CLAUDE.md §2.2). This runs in the gateway for EVERY message of EVERY user,
 * before consent, before any LLM. The full classifier arrives with the AI service (M6); this list is
 * the fallback that works even when that service is down.
 *
 * It is deliberately safety-first: it matches phrases anywhere in the text, so "no chest pain" or
 * "chest pain ki dawai kaunsi hai" also trigger it. A needless "call 112" is far cheaper than a
 * missed emergency. Voice notes are not covered until speech-to-text exists (M13).
 *
 * Phrases are written naturally (Latin, Devanagari, Hinglish spellings) and normalised by the same
 * function as the user's text, so spelling variants such as ज़हर/जहर or साँस/सांस need one entry.
 */
const SELF_HARM_PHRASES: readonly string[] = [
  // English
  'suicide',
  'suicidal',
  'kill myself',
  'killing myself',
  'end my life',
  'ending my life',
  'want to die',
  'wanna die',
  "don't want to live",
  'dont want to live',
  'hurt myself',
  'harm myself',
  'self harm',
  'selfharm',
  'cut myself',
  // Hinglish
  'khud ko nuksan',
  'khud ko khatam',
  'khudkushi',
  'khud kushi',
  'atmahatya',
  'aatmahatya',
  'aatmhatya',
  'jaan de dunga',
  'jaan de dungi',
  'jaan dena chahta',
  'jaan dena chahti',
  'marna chahta',
  'marna chahti',
  'mar jana chahta',
  'mar jaana chahta',
  'mar jana chahti',
  'mar jaana chahti',
  'zindagi khatam',
  'jeena nahi chahta',
  'jeena nahi chahti',
  // Hindi (Devanagari)
  'आत्महत्या',
  'खुदकुशी',
  'खुद को नुकसान',
  'खुद को खत्म',
  'मरना चाहता',
  'मरना चाहती',
  'जान दे दूंगा',
  'जान दे दूंगी',
  'जीना नहीं चाहता',
  'जीना नहीं चाहती',
  'ज़िंदगी खत्म',
];

const GENERAL_PHRASES: readonly string[] = [
  // English: chest / heart
  'chest pain',
  'pain in my chest',
  'pain in his chest',
  'pain in her chest',
  'pain in the chest',
  'pain in their chest',
  'pain in chest',
  'chest tightness',
  'tightness in my chest',
  'heart attack',
  // English: breathing
  "can't breathe",
  'cant breathe',
  'cannot breathe',
  'can not breathe',
  'difficulty breathing',
  'trouble breathing',
  'short of breath',
  'shortness of breath',
  'not breathing',
  'struggling to breathe',
  // English: consciousness / bleeding / poison / seizure / stroke
  'unconscious',
  'not responding',
  'passed out',
  'fainted',
  'collapsed',
  'heavy bleeding',
  'bleeding heavily',
  'bleeding a lot',
  'bleeding badly',
  "won't stop bleeding",
  'wont stop bleeding',
  'poisoned',
  'poisoning',
  'poison',
  'overdose',
  'overdosed',
  'overdosing',
  'seizure',
  'seizures',
  'convulsion',
  'convulsions',
  'face drooping',
  'slurred speech',
  'paralysis',
  'paralysed',
  'paralyzed',
  // Hinglish
  'seene me dard',
  'seene mein dard',
  'seene main dard',
  'chhati me dard',
  'chhati mein dard',
  'chati me dard',
  'chati mein dard',
  'chaati me dard',
  'chhaati me dard',
  'dil ka daura',
  'saans nahi',
  'sans nahi',
  'saans lene me takleef',
  'saans lene mein takleef',
  'saans phool',
  'saans phoolna',
  'dam ghut',
  'behosh',
  'behoshi',
  'zeher',
  'jehar',
  'zehar',
  'khoon bahut',
  'bahut khoon',
  'khoon nahi ruk',
  'khoon nahi rukta',
  'khoon beh raha',
  'daura pad',
  'mirgi',
  'lakwa',
  'lakva',
  // Hindi (Devanagari)
  'सीने में दर्द',
  'छाती में दर्द',
  'दिल का दौरा',
  'सांस नहीं',
  'सांस लेने में तकलीफ',
  'सांस फूल',
  'बेहोश',
  'बेहोशी',
  'जहर',
  'ज़हर',
  'ओवरडोज',
  'खून बहुत',
  'बहुत खून',
  'खून नहीं रुक',
  'खून बह रहा',
  'दौरा पड',
  'मिर्गी',
  'लकवा',
];

interface Keyword {
  value: string;
  /**
   * Latin phrases must match whole words ("poison" matches "he drank poison" but not "is this
   * poisonous"); inflections are therefore listed explicitly. Devanagari is matched as a substring
   * because Hindi words carry matras and suffixes that attach directly to the stem.
   */
  latin: boolean;
}

function compile(phrases: readonly string[]): Keyword[] {
  return [...new Set(phrases.map(normaliseForMatching).filter((phrase) => phrase.length > 0))].map(
    (value) => ({ value, latin: /^[a-z0-9]/.test(value) }),
  );
}

const SELF_HARM = compile(SELF_HARM_PHRASES);
const GENERAL = compile(GENERAL_PHRASES);

function matchesAny(normalised: string, keywords: readonly Keyword[]): boolean {
  const padded = ` ${normalised} `;
  return keywords.some((keyword) =>
    keyword.latin ? padded.includes(` ${keyword.value} `) : normalised.includes(keyword.value),
  );
}

/**
 * Does this message look like an emergency? `self_harm` wins over `general` (it adds Tele-MANAS
 * 14416 to the reply). Returns null for blank text or no match.
 */
export function detectEmergency(text: string): EmergencyKind | null {
  const normalised = normaliseForMatching(text);
  if (normalised.length === 0) {
    return null;
  }
  if (matchesAny(normalised, SELF_HARM)) {
    return 'self_harm';
  }
  if (matchesAny(normalised, GENERAL)) {
    return 'general';
  }
  return null;
}
