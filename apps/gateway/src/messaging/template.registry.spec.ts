import { TEMPLATES, TemplateRegistry } from './template.registry';
import { WhatsAppValidationError } from './whatsapp.errors';

const registry = new TemplateRegistry();

describe('TemplateRegistry', () => {
  it('builds dose_reminder with body params and three quick-reply payloads', () => {
    expect(
      registry.build('dose_reminder', 'hi', { medicines: 'Dolo 650', time: '08:00' }, [
        'taken:r1',
        'snooze:r1',
        'skip:r1',
      ]),
    ).toEqual({
      name: 'dose_reminder',
      languageCode: 'hi',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Dolo 650' },
            { type: 'text', text: '08:00' },
          ],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: 'taken:r1' }],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '1',
          parameters: [{ type: 'payload', payload: 'snooze:r1' }],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '2',
          parameters: [{ type: 'payload', payload: 'skip:r1' }],
        },
      ],
    });
  });

  it('builds a template without variables or buttons with no components at all', () => {
    expect(registry.build('generic_reengage', 'en')).toEqual({
      name: 'generic_reengage',
      languageCode: 'en',
      components: [],
    });
  });

  it('orders body parameters as {{1}}, {{2}}, {{3}} regardless of the object key order', () => {
    const built = registry.build('caregiver_missed_dose_alert', 'en', {
      time: '8:00 PM',
      user_label: 'Papa',
    });
    expect(built.components[0]).toEqual({
      type: 'body',
      parameters: [
        { type: 'text', text: 'Papa' },
        { type: 'text', text: '8:00 PM' },
      ],
    });
  });

  it('the caregiver alert has no medicine parameter at all (minimum necessary information)', () => {
    expect(TEMPLATES.caregiver_missed_dose_alert.bodyParams).toEqual(['user_label', 'time']);
    expect(() =>
      registry.build('caregiver_missed_dose_alert', 'en', { user_label: 'Papa' }),
    ).toThrow(/time/);
  });

  it('builds consent_reminder with two quick replies', () => {
    const built = registry.build('consent_reminder', 'hi', {}, ['consent_yes', 'consent_no']);
    expect(built.components).toHaveLength(2);
  });

  it('rejects a missing or blank parameter', () => {
    expect(() =>
      registry.build('dose_reminder', 'en', { medicines: 'X' }, ['a', 'b', 'c']),
    ).toThrow(/time/);
    expect(() =>
      registry.build('dose_reminder', 'en', { medicines: ' ', time: 'x' }, ['a', 'b', 'c']),
    ).toThrow(WhatsAppValidationError);
  });

  it('rejects the wrong number of button payloads', () => {
    const params = { medicines: 'X', time: 'y' };
    expect(() => registry.build('dose_reminder', 'en', params, ['a'])).toThrow(/3 button payload/);
    expect(() => registry.build('generic_reengage', 'en', {}, ['a'])).toThrow(
      WhatsAppValidationError,
    );
  });

  it('rejects a button payload over 128 characters', () => {
    expect(() => registry.build('consent_reminder', 'en', {}, ['x'.repeat(129), 'ok'])).toThrow(
      /128/,
    );
  });

  it('cleans parameter values Meta would reject (newlines, tabs, long space runs)', () => {
    const built = registry.build('caregiver_missed_dose_alert', 'en', {
      user_label: 'dad\nand\tmom',
      time: ' 8     PM ',
    });
    expect(built.components[0]).toMatchObject({
      parameters: [{ text: 'dad and mom' }, { text: '8   PM' }],
    });
  });

  it('knows exactly the templates we ship', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([
      'caregiver_invite',
      'caregiver_missed_dose_alert',
      'consent_reminder',
      'daily_summary',
      'dose_reminder',
      'generic_reengage',
      'reminder_renewal',
    ]);
    expect(registry.has('dose_reminder')).toBe(true);
    expect(registry.has('toString')).toBe(false);
  });
});
