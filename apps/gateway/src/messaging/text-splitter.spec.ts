import { MAX_TEXT_LENGTH, splitText } from './text-splitter';

describe('splitText', () => {
  it('returns short text unchanged', () => {
    expect(splitText('hello')).toEqual(['hello']);
  });

  it('returns [] for blank input', () => {
    expect(splitText('')).toEqual([]);
    expect(splitText('  \n\n ')).toEqual([]);
  });

  it('keeps text of exactly 4096 characters in one message', () => {
    const text = 'a'.repeat(MAX_TEXT_LENGTH);
    expect(splitText(text)).toEqual([text]);
  });

  it('splits at paragraph boundaries and packs paragraphs greedily', () => {
    const paragraph = 'p'.repeat(1500);
    const text = [paragraph, paragraph, paragraph, paragraph].join('\n\n');
    const parts = splitText(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(`${paragraph}\n\n${paragraph}`);
    expect(parts[1]).toBe(`${paragraph}\n\n${paragraph}`);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  });

  it('never exceeds the limit and loses no content for a long single paragraph', () => {
    const sentence = 'Yeh dawai khane ke baad leni hai. ';
    const text = sentence.repeat(400).trim(); // ~13.6k characters, one paragraph
    const parts = splitText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      expect(part.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    }
    const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim();
    expect(normalise(parts.join(' '))).toBe(normalise(text));
  });

  it('hard-cuts text without any whitespace', () => {
    const parts = splitText('x'.repeat(10_000));
    expect(parts.map((part) => part.length)).toEqual([4096, 4096, 1808]);
  });

  it('never cuts an emoji (surrogate pair) in half', () => {
    const text = '😀'.repeat(3000); // 6000 UTF-16 units, no whitespace
    const parts = splitText(text);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
      expect(part.replaceAll('😀', '')).toBe(''); // only whole emoji, none cut in half
    }
    expect(parts.join('')).toBe(text);
  });

  it('splits Devanagari text at the danda (।) sentence boundary', () => {
    const sentence = 'यह दवा खाने के बाद लेनी है। ';
    const parts = splitText(sentence.repeat(300).trim(), 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(1000);
      expect(part.endsWith('।')).toBe(true);
    }
  });

  it('honours a custom max', () => {
    expect(splitText('one\n\ntwo\n\nthree', 8)).toEqual(['one\n\ntwo', 'three']);
  });
});
