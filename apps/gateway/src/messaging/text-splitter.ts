/** WhatsApp text message body limit. */
export const MAX_TEXT_LENGTH = 4096;

/** Cut index that never falls between the two halves of a surrogate pair (emoji). */
function safeCut(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** Split one oversized paragraph at the best available boundary: line, sentence, space, hard cut. */
function splitLongParagraph(paragraph: string, max: number): string[] {
  const parts: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // Best boundary first: line break, then end of sentence (Devanagari danda or full stop), then
    // any space. A boundary is only used if it keeps the piece reasonably large.
    let cut = safeCut(rest, max);
    for (const marker of ['\n', '। ', '. ', ' ']) {
      const index = window.lastIndexOf(marker);
      if (index > max / 2) {
        // Keep the sentence-ending punctuation; drop a line break / space.
        cut = index + (marker === '\n' || marker === ' ' ? 0 : 1);
        break;
      }
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    parts.push(rest);
  }
  return parts;
}

/**
 * Split text into messages of at most `max` characters, preferring paragraph boundaries ("\n\n"),
 * then lines, sentences and words. Paragraphs are packed greedily so we send as few messages as
 * possible. Never returns an empty part; returns `[]` for blank input.
 */
export function splitText(text: string, max: number = MAX_TEXT_LENGTH): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.length <= max) {
    return [trimmed];
  }

  const parts: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) {
      parts.push(current);
      current = '';
    }
  };

  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const pieces = paragraph.length > max ? splitLongParagraph(paragraph, max) : [paragraph];
    for (const piece of pieces) {
      const candidate = current.length === 0 ? piece : `${current}\n\n${piece}`;
      if (candidate.length <= max) {
        current = candidate;
      } else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return parts;
}
