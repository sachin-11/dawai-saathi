import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { isLocale, localePath } from '@/lib/i18n';
import { CONTACT_EMAIL, GITHUB_URL } from '@/lib/site';

export async function SiteFooter() {
  const locale = await getLocale();
  const safe = isLocale(locale) ? locale : 'hi';
  const t = await getTranslations('footer');
  const nav = await getTranslations('nav');
  const common = await getTranslations('common');
  const link = 'inline-flex min-h-11 items-center underline-offset-4 hover:underline';
  return (
    <footer className="mt-16 shrink-0 border-t border-border bg-surface-2">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 md:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <p className="text-lg font-bold">{common('siteName')}</p>
          <p className="text-muted">{t('tagline')}</p>
          <p className="max-w-2xl text-sm text-muted">{common('disclaimer')}</p>
        </div>
        <nav aria-label="Footer">
          <ul className="space-y-1 text-sm">
            <li>
              <Link className={link} href={localePath(safe, '/privacy')}>
                {nav('privacy')}
              </Link>
            </li>
            <li>
              <Link className={link} href={localePath(safe, '/terms')}>
                {nav('terms')}
              </Link>
            </li>
            <li>
              <a className={link} href={GITHUB_URL} rel="noopener noreferrer">
                {t('code')}
              </a>
            </li>
            <li>
              <a className={link} href={`mailto:${CONTACT_EMAIL}`}>
                {t('contact')}: {CONTACT_EMAIL}
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
