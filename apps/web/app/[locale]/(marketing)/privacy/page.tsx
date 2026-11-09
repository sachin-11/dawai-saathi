import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';

import { LegalPage } from '@/components/legal-page';
import { LEGAL } from '@/content/legal';
import { isLocale } from '@/lib/i18n';

export async function generateMetadata(): Promise<Metadata> {
  const raw = await getLocale();
  return { title: LEGAL.privacy[isLocale(raw) ? raw : 'hi'].title };
}

export default function PrivacyPage() {
  return <LegalPage kind="privacy" />;
}
