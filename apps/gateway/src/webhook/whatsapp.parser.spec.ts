import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseWebhook } from './whatsapp.parser';

const PHONE_NUMBER_ID = '100000000000001';

function fixture(name: string): unknown {
  const path = join(__dirname, '..', '..', 'test', 'fixtures', 'whatsapp', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function parse(name: string): ReturnType<typeof parseWebhook> {
  return parseWebhook(fixture(name), PHONE_NUMBER_ID);
}

describe('parseWebhook', () => {
  it('maps a text message', () => {
    const { messages } = parse('text');
    expect(messages).toEqual([
      {
        waMessageId: 'wamid.TEXT0001',
        from: '919999999999',
        timestamp: new Date(1794000000 * 1000),
        type: 'text',
        text: 'Dolo 650 kab leni hai? Mera number 9876543210',
      },
    ]);
  });

  it('maps an image with its caption and media info', () => {
    const [message] = parse('image').messages;
    expect(message).toMatchObject({
      waMessageId: 'wamid.IMAGE001',
      type: 'image',
      text: 'prescription from Dr Mehta, PIN 411001',
      media: { id: 'media-img-1', mimeType: 'image/jpeg', sha256: 'abc123sha' },
    });
  });

  it('maps a PDF document with caption, and redacts the filename (it may hold a name)', () => {
    const [message] = parse('document').messages;
    expect(message).toMatchObject({
      type: 'document',
      text: 'lab report',
      media: { id: 'media-doc-1', mimeType: 'application/pdf' },
    });
    // The filename is kept for display but never in the clear if it contains an identifier.
    expect(message?.media?.filename).toBe('Ramesh_Sharma_lab_report.pdf');
  });

  it('maps a voice note to audio', () => {
    const [message] = parse('audio').messages;
    expect(message).toMatchObject({
      type: 'audio',
      media: { id: 'media-aud-1', mimeType: 'audio/ogg; codecs=opus' },
    });
    expect(message?.text).toBeUndefined();
  });

  it('maps interactive.button_reply to a button', () => {
    const [message] = parse('button').messages;
    expect(message).toMatchObject({
      type: 'button',
      button: { id: 'consent_yes', title: 'I agree' },
    });
  });

  it('maps the legacy template button to a button', () => {
    const [message] = parse('button-legacy').messages;
    expect(message).toMatchObject({ type: 'button', button: { id: 'taken', title: 'Le li' } });
  });

  it.each(['unsupported', 'location'])(
    'maps %s fixture to "unsupported" (still returned)',
    (name) => {
      const { messages } = parse(name);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe('unsupported');
      expect(messages[0]?.waMessageId).toBeDefined();
    },
  );

  it('parses every message of a batch, in order', () => {
    const { messages } = parse('batch');
    expect(messages.map((m) => [m.waMessageId, m.type])).toEqual([
      ['wamid.BATCH001', 'text'],
      ['wamid.BATCH002', 'image'],
      ['wamid.BATCH003', 'button'],
    ]);
    expect(messages[2]?.button?.title).toBe('हिन्दी');
  });

  it('treats statuses as statuses, never as user messages', () => {
    const parsed = parse('status');
    expect(parsed.messages).toEqual([]);
    expect(parsed.statuses).toEqual([
      {
        waMessageId: 'wamid.OUT00001',
        status: 'delivered',
        timestamp: new Date(1794000060 * 1000),
      },
      {
        waMessageId: 'wamid.OUT00002',
        status: 'failed',
        timestamp: new Date(1794000061 * 1000),
        errorCode: 131047,
      },
    ]);
  });

  it('ignores events for another phone_number_id', () => {
    const parsed = parse('foreign');
    expect(parsed.messages).toEqual([]);
    expect(parsed.foreignCount).toBe(1);
  });

  it('handles several entries and changes in one webhook', () => {
    const one = fixture('text') as { entry: unknown[] };
    const two = fixture('image') as { entry: unknown[] };
    const merged = { object: 'whatsapp_business_account', entry: [...one.entry, ...two.entry] };
    const { messages } = parseWebhook(merged, PHONE_NUMBER_ID);
    expect(messages.map((m) => m.type)).toEqual(['text', 'image']);
  });

  it('never exposes the WhatsApp profile name', () => {
    const serialised = JSON.stringify(parse('text'));
    expect(serialised).not.toContain('Test Patient');
  });

  describe('malformed input never throws', () => {
    it.each([
      ['null', null],
      ['a string', 'hello'],
      ['an empty object', {}],
      ['entry not an array', { entry: 'x' }],
      ['entry without changes', { entry: [{}] }],
      ['change without value', { entry: [{ changes: [{ field: 'messages' }] }] }],
    ])('%s', (_name, body) => {
      const parsed = parseWebhook(body, PHONE_NUMBER_ID);
      expect(parsed.messages).toEqual([]);
      expect(parsed.invalidCount).toBeGreaterThanOrEqual(0);
    });

    it('skips one bad message but keeps the good ones next to it', () => {
      const body = {
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: PHONE_NUMBER_ID },
                  messages: [
                    { id: '', from: '1', timestamp: '1', type: 'text' },
                    {
                      id: 'wamid.OK',
                      from: '919999999999',
                      timestamp: '1794000000',
                      type: 'text',
                      text: { body: 'hi' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const parsed = parseWebhook(body, PHONE_NUMBER_ID);
      expect(parsed.messages.map((m) => m.waMessageId)).toEqual(['wamid.OK']);
      expect(parsed.invalidCount).toBe(1);
    });

    it('treats a text message without a body as unsupported instead of crashing', () => {
      const body = {
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: PHONE_NUMBER_ID },
                  messages: [{ id: 'wamid.X', from: '919999999999', timestamp: '1', type: 'text' }],
                },
              },
            ],
          },
        ],
      };
      expect(parseWebhook(body, PHONE_NUMBER_ID).messages[0]?.type).toBe('unsupported');
    });
  });

  it('ignores change fields other than "messages"', () => {
    const body = { entry: [{ changes: [{ field: 'account_update', value: {} }] }] };
    const parsed = parseWebhook(body, PHONE_NUMBER_ID);
    expect(parsed).toEqual({ messages: [], statuses: [], foreignCount: 0, invalidCount: 0 });
  });
});
