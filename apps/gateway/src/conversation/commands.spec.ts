import type { InboundMessage } from '../webhook/inbound-message';
import { BUTTON_ID, type CommandName, parseCommand } from './commands';
import { classifyInbound } from './signals';

describe('parseCommand', () => {
  it.each<[string, CommandName]>([
    ['help', 'help'],
    ['HELP', 'help'],
    ['  Help  ', 'help'],
    ['help!', 'help'],
    ['help 🙏', 'help'],
    ['madad', 'help'],
    ['मदद', 'help'],
    ['?', 'help'],
    ['??', 'help'],
    ['language', 'language'],
    ['bhasha', 'language'],
    ['भाषा', 'language'],
    ['lang', 'language'],
    ['Language.', 'language'],
    ['delete', 'delete'],
    ['DELETE', 'delete'],
    ['delete my data', 'delete'],
    ['Delete   my   data', 'delete'],
    ['data delete karo', 'delete'],
    ['डिलीट', 'delete'],
    ['stop reminders', 'stop_reminders'],
    ['STOP REMINDERS', 'stop_reminders'],
    ['reminder band karo', 'stop_reminders'],
    ['stop', 'stop_reminders'],
    ['stop.', 'stop_reminders'],
    ['start reminders', 'start_reminders'],
    ['reminder chalu karo', 'start_reminders'],
    ['meds', 'meds'],
    ['MEDS', 'meds'],
    ['dawai', 'meds'],
    ['dawaiyan', 'meds'],
    ['दवाई', 'meds'],
  ])('%p -> %s', (text, expected) => {
    expect(parseCommand(text)).toBe(expected);
  });

  it.each([
    'help me with my medicine',
    'please delete this from my prescription',
    'I want to stop taking this tablet',
    'stop taking dolo',
    'dawai kab leni hai',
    'meds list please',
    'language is hindi',
    'delete the photo I sent',
    'hello',
    'hi',
    '',
    '   ',
    'helpp',
    'helps',
    'दवाई कब लेनी है',
    '1',
  ])('does NOT treat %p as a command (exact match only)', (text) => {
    expect(parseCommand(text)).toBeNull();
  });
});

describe('BUTTON_ID', () => {
  it('uses stable, namespaced ids', () => {
    expect(BUTTON_ID).toEqual({
      langHi: 'lang:hi',
      langEn: 'lang:en',
      consentYes: 'consent:yes',
      consentNo: 'consent:no',
      deleteConfirm: 'delete:confirm',
      deleteCancel: 'delete:cancel',
    });
  });
});

describe('classifyInbound', () => {
  const base = { waMessageId: 'w', from: '9199', timestamp: new Date() };
  const msg = (extra: Partial<InboundMessage> & Pick<InboundMessage, 'type'>): InboundMessage => ({
    ...base,
    ...extra,
  });

  it('finds a command in a plain text message', () => {
    expect(classifyInbound(msg({ type: 'text', text: 'help' }))).toEqual({ command: 'help' });
  });

  it('finds an emergency in text', () => {
    expect(classifyInbound(msg({ type: 'text', text: 'chest pain' }))).toEqual({
      emergency: 'general',
    });
  });

  it('reports both when both apply', () => {
    // a command word that is also part of an emergency phrase cannot happen, but the shape allows both
    const signals = classifyInbound(msg({ type: 'text', text: 'stop' }));
    expect(signals).toEqual({ command: 'stop_reminders' });
  });

  it('checks image/document captions for emergencies but never treats them as commands', () => {
    expect(
      classifyInbound(
        msg({ type: 'image', text: 'delete', media: { id: 'm', mimeType: 'image/jpeg' } }),
      ),
    ).toEqual({});
    expect(
      classifyInbound(
        msg({
          type: 'image',
          text: 'he is unconscious',
          media: { id: 'm', mimeType: 'image/jpeg' },
        }),
      ),
    ).toEqual({ emergency: 'general' });
  });

  it('ignores button taps entirely (routed by id)', () => {
    expect(
      classifyInbound(
        msg({ type: 'button', text: 'delete', button: { id: 'x', title: 'delete' } }),
      ),
    ).toEqual({});
  });

  it('returns no signals for media without text and for unsupported types', () => {
    expect(
      classifyInbound(msg({ type: 'audio', media: { id: 'm', mimeType: 'audio/ogg' } })),
    ).toEqual({});
    expect(classifyInbound(msg({ type: 'unsupported' }))).toEqual({});
  });
});
