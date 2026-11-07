import { TEMPLATES, TemplateRegistry } from './template.registry';
import { WhatsAppValidationError } from './whatsapp.errors';

const registry = new TemplateRegistry();

describe('TemplateRegistry', () => {
  it('builds dose_reminder with body params and three quick-reply payloads', () => {
    expect(
      registry.build(
        'dose_reminder',
        'hi',
        { medicine_name: 'Dolo 650', dose_timing: '1 गोली, खाने के बाद' },
        ['taken:r1', 'snooze:r1', 'skip:r1'],
      ),
    ).toEqual({
      name: 'dose_reminder',
      languageCode: 'hi',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Dolo 650' },
            { type: 'text', text: '1 गोली, खाने के बाद' },
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
      due_time: '8:00 PM',
      medicine_name: 'Metformin',
      patient_label: 'your father',
    });
    expect(built.components[0]).toEqual({
      type: 'body',
      parameters: [
        { type: 'text', text: 'your father' },
        { type: 'text', text: 'Metformin' },
        { type: 'text', text: '8:00 PM' },
      ],
    });
  });

  it('builds consent_reminder with two quick replies', () => {
    const built = registry.build('consent_reminder', 'hi', {}, ['consent_yes', 'consent_no']);
    expect(built.components).toHaveLength(2);
  });

  it('rejects a missing or blank parameter', () => {
    expect(() =>
      registry.build('dose_reminder', 'en', { medicine_name: 'X' }, ['a', 'b', 'c']),
    ).toThrow(/dose_timing/);
    expect(() =>
      registry.build('dose_reminder', 'en', { medicine_name: ' ', dose_timing: 'x' }, [
        'a',
        'b',
        'c',
      ]),
    ).toThrow(WhatsAppValidationError);
  });

  it('rejects the wrong number of button payloads', () => {
    const params = { medicine_name: 'X', dose_timing: 'y' };
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
      patient_label: 'dad\nand\tmom',
      medicine_name: 'a      b',
      due_time: ' 8 PM ',
    });
    expect(built.components[0]).toMatchObject({
      parameters: [{ text: 'dad and mom' }, { text: 'a   b' }, { text: '8 PM' }],
    });
  });

  it('knows exactly the four templates we ship', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([
      'caregiver_missed_dose_alert',
      'consent_reminder',
      'dose_reminder',
      'generic_reengage',
    ]);
    expect(registry.has('dose_reminder')).toBe(true);
    expect(registry.has('toString')).toBe(false);
  });
});
