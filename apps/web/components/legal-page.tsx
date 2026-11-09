import { AlertTriangle } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { LEGAL } from '@/content/legal';
import { isLocale } from '@/lib/i18n';
import { LEGAL_UPDATED } from '@/lib/site';

export async function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : 'hi';
  const doc = LEGAL[kind][locale];
  const common = await getTranslations('common');
  return (
    <article className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      <header className="space-y-4">
        <h1 className="text-3xl font-extrabold sm:text-4xl">{doc.title}</h1>
        <p className="text-sm text-muted">
          {common('lastUpdated')}: <time dateTime={LEGAL_UPDATED}>{LEGAL_UPDATED}</time>
        </p>
        <p
          role="note"
          data-testid="draft-banner"
          className="flex gap-3 rounded-xl border-2 border-warn bg-warn-soft p-4 font-semibold"
        >
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          {doc.draftBanner}
        </p>
        <p className="text-lg">{doc.intro}</p>
      </header>
      {doc.sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          aria-labelledby={`${section.id}-h`}
          className="space-y-3"
        >
          <h2 id={`${section.id}-h`} className="text-xl font-bold">
            {section.heading}
          </h2>
          {section.paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
          {section.bullets && (
            <ul className="list-disc space-y-2 pl-6">
              {section.bullets.map((bullet, index) => (
                <li key={index}>{bullet}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </article>
  );
}
