import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';

import { Playground } from '@/components/demo/playground';
import { TURNSTILE_SITE_KEY } from '@/lib/site';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('demo');
  return { title: t('title'), description: t('subtitle') };
}

export default async function DemoPage() {
  const locale = await getLocale();
  const t = await getTranslations('demo');
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <header className="max-w-3xl space-y-3">
        <h1 className="text-3xl font-extrabold sm:text-4xl">{t('title')}</h1>
        <p className="text-lg text-muted">{t('subtitle')}</p>
      </header>
      <Playground
        defaultLanguage={locale === 'en' ? 'en' : 'hi'}
        turnstileSiteKey={TURNSTILE_SITE_KEY}
        nonce={nonce}
      />
    </div>
  );
}
