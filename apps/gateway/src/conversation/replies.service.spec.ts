import type { PinoLogger } from 'nestjs-pino';

import { I18nService } from '../messaging/i18n/i18n.service';
import type { OutboundRequest } from '../messaging/outbound.types';
import type { OutboundService } from '../messaging/outbound.service';
import { BUTTON_ID } from './commands';
import { EMERGENCY_PRIORITY, RepliesService } from './replies.service';

const i18n = new I18nService({
  setContext: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as PinoLogger);

function setup(language: 'hi' | 'en' = 'hi'): {
  session: ReturnType<RepliesService['session']>;
  sent: OutboundRequest[];
} {
  const sent: OutboundRequest[] = [];
  const outbound = {
    enqueue: jest.fn().mockImplementation((_userId: string, request: OutboundRequest) => {
      sent.push(request);
      return Promise.resolve();
    }),
  } as unknown as OutboundService;
  const session = new RepliesService(outbound, i18n).session({
    userId: 'user-1',
    language,
    messageId: 'msg-1',
    requestId: 'req-1',
  });
  return { session, sent };
}

describe('ReplySession', () => {
  it('numbers replies 0, 1, 2... for one inbound message (stable outbound job ids on retries)', async () => {
    const { session, sent } = setup();
    await session.text('help.body');
    await session.text('meds.none');
    await session.buttons('delete.confirm_question', {}, [
      { id: BUTTON_ID.deleteConfirm, titleKey: 'buttons.delete_yes' },
    ]);
    expect(sent.map((request) => [request.sourceMessageId, request.replyIndex])).toEqual([
      ['msg-1', 0],
      ['msg-1', 1],
      ['msg-1', 2],
    ]);
    expect(sent.every((request) => request.requestId === 'req-1')).toBe(true);
  });

  it('a fresh session for a retried job produces the SAME indices', async () => {
    const first = setup();
    await first.session.text('help.body');
    const second = setup();
    await second.session.text('help.body');
    expect(second.sent[0]?.replyIndex).toBe(first.sent[0]?.replyIndex);
  });

  it('translates text and button titles into the session language', async () => {
    const hi = setup('hi');
    await hi.session.buttons('onboarding.choose_language', {}, [
      { id: BUTTON_ID.consentYes, titleKey: 'buttons.consent_yes' },
      { id: BUTTON_ID.consentNo, titleKey: 'buttons.consent_no' },
    ]);
    expect(hi.sent[0]?.content).toMatchObject({
      kind: 'buttons',
      buttons: [
        { id: 'consent:yes', title: 'मैं सहमत हूँ' },
        { id: 'consent:no', title: 'अभी नहीं' },
      ],
    });

    const en = setup('en');
    await en.session.buttons('onboarding.choose_language', {}, [
      { id: BUTTON_ID.consentYes, titleKey: 'buttons.consent_yes' },
    ]);
    expect(en.sent[0]?.content).toMatchObject({
      buttons: [{ id: 'consent:yes', title: 'I agree' }],
    });
  });

  it('switches language for the rest of the session (e.g. right after the user chose one)', async () => {
    const { session, sent } = setup('hi');
    session.useLanguage('en');
    await session.text('language.changed');
    expect(sent[0]?.content).toEqual({ kind: 'text', body: 'Language set to English.' });
    expect(session.currentLanguage).toBe('en');
  });

  describe('rawEmergencyText (the AI service emergency reply)', () => {
    it('is plain text with the highest queue priority', async () => {
      const { session, sent } = setup('hi');
      await session.rawEmergencyText('अभी 112 पर कॉल करें');
      expect(sent[0]?.content).toEqual({ kind: 'text', body: 'अभी 112 पर कॉल करें' });
      expect(sent[0]?.priority).toBe(EMERGENCY_PRIORITY);
    });
  });

  describe('emergency', () => {
    it('is sent with the highest queue priority', async () => {
      const { session, sent } = setup('en');
      await session.emergency('general', false);
      expect(sent[0]?.priority).toBe(EMERGENCY_PRIORITY);
      expect(EMERGENCY_PRIORITY).toBe(1);
    });

    it('general emergency mentions 112 and 108', async () => {
      const { session, sent } = setup('en');
      await session.emergency('general', false);
      const body = (sent[0]?.content as { body: string }).body;
      expect(body).toContain('112');
      expect(body).toContain('108');
    });

    it('self-harm adds Tele-MANAS 14416 (and still points to 112 / 108)', async () => {
      const { session, sent } = setup('hi');
      await session.emergency('self_harm', false);
      const body = (sent[0]?.content as { body: string }).body;
      expect(body).toContain('14416');
      expect(body).toContain('Tele-MANAS');
      expect(body).toContain('112');
    });

    it('is bilingual (Hindi + English in ONE message) before a language was chosen', async () => {
      const { session, sent } = setup('hi');
      await session.emergency('self_harm', true);
      expect(sent).toHaveLength(1);
      const body = (sent[0]?.content as { body: string }).body;
      expect(body).toMatch(/[ऀ-ॿ]/);
      expect(body).toContain('You are not alone');
      expect(body).toContain('14416');
    });
  });

  it('sends textParts and textLines as ONE message each (separate jobs could arrive out of order)', async () => {
    const { session, sent } = setup('en');
    await session.textParts(['common.received_processing', 'dev.ai_not_ready']);
    await session.textLines('meds.list_header', [
      { key: 'meds.item', params: { name: 'Dolo 650', timings: '08:00, 20:00' } },
      { key: 'meds.item', params: { name: 'Metformin', timings: '09:00' } },
    ]);
    expect(sent).toHaveLength(2);
    expect((sent[0]?.content as { body: string }).body).toContain('\n\n');
    expect((sent[1]?.content as { body: string }).body).toBe(
      'Your active medicines:\n• Dolo 650 — 08:00, 20:00\n• Metformin — 09:00',
    );
  });
});
