import { parseWhatsappText } from '@/lib/whatsapp-format';
import type { DemoReply } from '@/lib/demo-types';

/**
 * A phone mockup showing `reply.text` and the buttons exactly as the user would get them. The text is
 * rendered as React text nodes (no innerHTML), so nothing in a reply can inject markup.
 */
export function WhatsappPreview({
  reply,
  time,
  title,
  buttonsLabel,
}: {
  reply: DemoReply;
  time: string;
  title: string;
  buttonsLabel: string;
}) {
  const lines = parseWhatsappText(reply.text);
  return (
    <figure className="mx-auto w-full max-w-sm" aria-label={title}>
      <div className="rounded-[2rem] border-4 border-ink/80 bg-wa-bg p-3 shadow-lg">
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-primary-ink">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-full bg-primary-ink text-sm font-bold text-primary"
          >
            DS
          </span>
          <span className="text-sm font-semibold">Dawai Saathi</span>
        </div>
        <div
          className="max-h-[32rem] overflow-y-auto"
          tabIndex={0}
          role="region"
          aria-label={title}
        >
          <div className="rounded-xl rounded-tl-none bg-wa-bubble px-3 py-2 text-[0.95rem] text-wa-ink shadow-sm">
            <div data-testid="wa-text" lang={reply.language} className="break-words">
              {lines.map((segments, i) =>
                segments.length === 1 && segments[0]?.kind === 'text' && segments[0].text === '' ? (
                  <div key={i} className="h-3" aria-hidden />
                ) : (
                  <p key={i} className="whitespace-pre-wrap">
                    {segments.map((segment, j) =>
                      segment.kind === 'bold' ? (
                        <strong key={j}>{segment.text}</strong>
                      ) : segment.kind === 'italic' ? (
                        <em key={j}>{segment.text}</em>
                      ) : (
                        <span key={j}>{segment.text}</span>
                      ),
                    )}
                  </p>
                ),
              )}
            </div>
            <div className="mt-1 text-right text-[0.7rem] text-muted">{time}</div>
          </div>
          {reply.buttons.length > 0 && (
            <ul aria-label={buttonsLabel} className="mt-1 space-y-1">
              {reply.buttons.map((button) => (
                <li
                  key={button.id}
                  className="rounded-xl bg-wa-bubble px-3 py-2.5 text-center text-sm font-semibold text-primary shadow-sm"
                >
                  {button.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </figure>
  );
}
