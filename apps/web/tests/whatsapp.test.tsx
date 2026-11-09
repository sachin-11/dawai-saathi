import { screen } from '@testing-library/react';

import { WhatsappPreview } from '@/components/demo/whatsapp-preview';
import { parseWhatsappLine, parseWhatsappText } from '@/lib/whatsapp-format';
import { renderWithIntl } from './helpers';

const reply = (text: string, buttons: { id: string; title: string }[] = []) => ({
  language: 'en' as const,
  text,
  buttons,
});

describe('WhatsApp formatting', () => {
  it('parses *bold* and _italic_ at word edges only', () => {
    expect(parseWhatsappLine('Take *Dolo 650* now')).toEqual([
      { kind: 'text', text: 'Take ' },
      { kind: 'bold', text: 'Dolo 650' },
      { kind: 'text', text: ' now' },
    ]);
    expect(parseWhatsappLine('_careful_')).toEqual([{ kind: 'italic', text: 'careful' }]);
    // 2 * 3 * 4 is arithmetic, not bold (the markers touch spaces)
    expect(parseWhatsappLine('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
    expect(parseWhatsappLine('snake_case_name')).toEqual([
      { kind: 'text', text: 'snake_case_name' },
    ]);
  });

  it('keeps blank lines', () => {
    expect(parseWhatsappText('a\n\nb')).toHaveLength(3);
  });
});

describe('WhatsappPreview', () => {
  const props = { time: '10:42', title: 'Preview', buttonsLabel: 'Buttons' };

  it('renders the text, bold segments and the buttons in order', () => {
    renderWithIntl(
      <WhatsappPreview
        {...props}
        reply={reply('*Dolo 650*: 1 tablet\nafter food', [
          { id: 'a', title: 'Set reminders' },
          { id: 'b', title: 'Generic details' },
        ])}
      />,
    );
    expect(screen.getByText('Dolo 650').tagName).toBe('STRONG');
    expect(screen.getByText('after food')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Set reminders', 'Generic details']);
  });

  it('has no button list when there are no buttons', () => {
    renderWithIntl(<WhatsappPreview {...props} reply={reply('hello')} />);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('handles a very long reply without truncating it', () => {
    const long = Array.from({ length: 120 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    renderWithIntl(<WhatsappPreview {...props} reply={reply(long)} />);
    expect(screen.getByTestId('wa-text').textContent).toContain('line 119');
  });

  it('never turns reply text into markup', () => {
    renderWithIntl(
      <WhatsappPreview
        {...props}
        reply={reply('<img src=x onerror=alert(1)> <script>boom()</script>')}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByTestId('wa-text').textContent).toContain('<img src=x');
  });
});
