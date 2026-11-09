export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string };

/**
 * WhatsApp formatting, as the app shows it: `*bold*` and `_italic_` (only when the markers touch the
 * text and sit at a word edge). Everything else, including HTML, stays plain text: the preview renders
 * these segments as React text nodes, so a reply can never inject markup.
 */
export function parseWhatsappLine(line: string): Segment[] {
  const out: Segment[] = [];
  const pattern = /(^|[\s(])([*_])(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,:;!?])/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const start = match.index + (match[1]?.length ?? 0);
    if (start > last) out.push({ kind: 'text', text: line.slice(last, start) });
    out.push({ kind: match[2] === '*' ? 'bold' : 'italic', text: match[3] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) });
  return out.length > 0 ? out : [{ kind: 'text', text: line }];
}

/** A reply as lines (blank lines kept, they separate blocks). */
export function parseWhatsappText(text: string): Segment[][] {
  return text.split('\n').map(parseWhatsappLine);
}
