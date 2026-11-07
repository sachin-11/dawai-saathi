/** Devanagari nukta (ज़ = ज + ़): folded away so "ज़हर" and "जहर" are the same word. */
const NUKTA = String.fromCodePoint(0x093c);
/** Devanagari candrabindu (साँस) and anusvara (सांस): both spellings are folded to the anusvara. */
const CANDRABINDU = String.fromCodePoint(0x0901);
const ANUSVARA = String.fromCodePoint(0x0902);

/** "dardddd" -> "dard", "seeene" stays 2 vowels: repeated Latin consonants collapse to one letter... */
const LATIN_CONSONANT_RUN = /([b-df-hj-np-tv-z])\1+/g;
/** ...and runs of 3+ identical Latin vowels collapse to two ("saaaans" -> "saans"). */
const LATIN_VOWEL_RUN = /([aeiou])\1{2,}/g;

/**
 * Normalise free text so that keyword and command matching survives the ways people actually type
 * on a phone: capitals, punctuation, emoji, repeated spaces and the many spellings of Devanagari.
 *
 *  - lower-case, Unicode-normalised
 *  - Devanagari nukta and candrabindu are folded (see the constants above)
 *  - zero-width joiners and other invisible format characters are dropped
 *  - everything that is not a letter, number or combining mark becomes a space ("can't" -> "can t")
 *  - runs of whitespace collapse to one space
 *
 * Keyword lists must be passed through this same function (see `emergency-keywords.ts`) so both
 * sides are compared in the same form.
 */
export function normaliseForMatching(text: string): string {
  return text
    .normalize('NFD')
    .toLowerCase()
    .replace(/\p{Cf}/gu, '')
    .replaceAll(NUKTA, '')
    .replaceAll(CANDRABINDU, ANUSVARA)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalisation for the EMERGENCY matcher: everything `normaliseForMatching` does, plus squeezing of
 * repeated Latin letters ("dardddd" -> "dard"). Commands do not use this ("helpp" is not HELP).
 * The AI service implements the identical function; shared vectors keep the two in sync.
 */
export function normaliseForEmergency(text: string): string {
  return normaliseForMatching(text)
    .replace(LATIN_CONSONANT_RUN, '$1')
    .replace(LATIN_VOWEL_RUN, '$1$1');
}
