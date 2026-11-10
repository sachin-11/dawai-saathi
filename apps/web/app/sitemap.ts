import type { MetadataRoute } from 'next';

import { localePath } from '@/lib/i18n';
import { LEGAL_UPDATED, SITE_URL } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ['/', '/demo', '/privacy', '/terms'];
  return pages.flatMap((path) =>
    (['hi', 'en'] as const).map((locale) => ({
      url: `${SITE_URL}${localePath(locale, path)}`,
      lastModified: path === '/privacy' || path === '/terms' ? LEGAL_UPDATED : undefined,
      alternates: {
        languages: {
          hi: `${SITE_URL}${localePath('hi', path)}`,
          en: `${SITE_URL}${localePath('en', path)}`,
        },
      },
    })),
  );
}
