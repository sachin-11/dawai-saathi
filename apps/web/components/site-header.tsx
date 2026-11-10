import { Pill } from 'lucide-react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { LanguageSwitch } from '@/components/language-switch';
import { buttonVariants } from '@/components/ui/button';
import { isLocale, localePath } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export async function SiteHeader() {
  const locale = await getLocale();
  const safe = isLocale(locale) ? locale : 'hi';
  const t = await getTranslations('nav');
  const common = await getTranslations('common');
  const home = localePath(safe);
  const anchors = [
    ['how', '#how'],
    ['features', '#features'],
    ['safety', '#safety'],
    ['engineers', '#engineers'],
    ['faq', '#faq'],
  ] as const;
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/85">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-ink"
      >
        {common('skip')}
      </a>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <Link
          href={home}
          className="flex items-center gap-2 text-lg font-bold"
          aria-label={common('siteName')}
        >
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-ink">
            <Pill className="size-5" aria-hidden />
          </span>
          {common('siteName')}
        </Link>
        <nav
          aria-label={common('mainNav')}
          className="order-3 w-full overflow-x-auto md:order-none md:w-auto"
        >
          <ul className="flex gap-1 whitespace-nowrap">
            {anchors.map(([key, hash]) => (
              <li key={key}>
                <Link
                  href={`${home === '/' ? '' : home}/${hash}`}
                  className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium hover:bg-surface-2"
                >
                  {t(key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-2">
          <LanguageSwitch label={common('switchLabel')} ariaLabel={common('switchTo')} />
          <Link
            href={localePath(safe, '/demo')}
            className={cn(
              buttonVariants({ variant: 'primary', size: 'sm' }),
              'hidden sm:inline-flex',
            )}
          >
            {t('demo')}
          </Link>
        </div>
      </div>
    </header>
  );
}
