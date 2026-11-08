/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code: a missing value fails the test anyway */
import type { PinoLogger } from 'nestjs-pino';

import { I18nService } from '../messaging/i18n/i18n.service';
import { TemplateRegistry } from '../messaging/template.registry';
import { ReminderMessages } from './reminder-messages';

const i18n = new I18nService({
  setContext: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as PinoLogger);
const messages = new ReminderMessages(i18n);
const registry = new TemplateRegistry();
const SLOT = new Date('2026-11-10T02:30:00Z'); // 08:00 IST

const build = (
  medicines: Parameters<ReminderMessages['slotRequest']>[0]['medicines'],
  language: 'hi' | 'en' = 'en',
) =>
  messages.slotRequest({
    language,
    timezone: 'Asia/Kolkata',
    scheduledAt: SLOT,
    medicines,
    sourceMessageId: 'rem_u_1',
    replyIndex: 0,
  });

describe('ReminderMessages', () => {
  it('groups all medicines of a slot into ONE interactive message with three buttons', () => {
    const request = build([
      { name: 'Dolo 650', dose: '1 tablet', food: 'after' },
      { name: 'Metformin 500', dose: null, food: 'with' },
      { name: 'Vitamin D', dose: '1 capsule', food: 'any' },
    ]);
    expect(request.content.kind).toBe('buttons');
    const content = request.content as { body: string; buttons: { id: string; title: string }[] };
    expect(content.body).toContain('08:00');
    expect(content.body).toContain('• Dolo 650 — 1 tablet, after food');
    expect(content.body).toContain('• Metformin 500 — with food');
    expect(content.body).toContain('• Vitamin D — 1 capsule');
    expect(content.buttons.map((button) => button.id)).toEqual([
      'rem:taken:1794277800',
      'rem:snooze:1794277800',
      'rem:skip:1794277800',
    ]);
  });

  it('carries the same three payloads in a valid template fallback for outside the 24 h window', () => {
    const request = build([
      { name: 'Dolo 650', dose: '1 tablet', food: 'after' },
      { name: 'Metformin 500', dose: null, food: 'any' },
    ]);
    const fallback = request.templateFallback!;
    expect(fallback).toMatchObject({
      template: 'dose_reminder',
      language: 'en',
      params: { medicines: 'Dolo 650 (1 tablet, after food); Metformin 500', time: '08:00' },
      buttonPayloads: ['rem:taken:1794277800', 'rem:snooze:1794277800', 'rem:skip:1794277800'],
    });
    const built = registry.build(
      fallback.template,
      fallback.language,
      fallback.params,
      fallback.buttonPayloads,
    );
    expect(built.name).toBe('dose_reminder');
    expect(built.components).toHaveLength(4);
  });

  it('writes the message in the user language', () => {
    const request = build([{ name: 'Dolo 650', dose: '1 गोली', food: 'before' }], 'hi');
    const body = (request.content as { body: string }).body;
    expect(body).toContain('दवा का समय');
    expect(body).toContain('खाने से पहले');
  });

  it('keeps a very long list inside the WhatsApp body limit and says how many are left', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `Medicine number ${i} with a rather long name`,
      dose: '1 tablet',
      food: 'after' as const,
    }));
    const body = (build(many).content as { body: string }).body;
    expect(body.length).toBeLessThanOrEqual(1024);
    expect(body).toMatch(/\+\d+ more/);
    const fallback = build(many).templateFallback!;
    expect((fallback.params?.['medicines'] ?? '').length).toBeLessThanOrEqual(900);
  });

  it('never invents text: only names, doses and food relation from the data appear', () => {
    const body = (
      build([{ name: 'Dolo 650', dose: null, food: 'any' }]).content as { body: string }
    ).body;
    expect(body).toContain('• Dolo 650');
    expect(body).not.toContain('—');
  });
});
