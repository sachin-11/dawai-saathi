import type { Metadata, Viewport } from 'next';
import { Noto_Sans, Noto_Sans_Devanagari } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import '../globals.css';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { isLocale } from '@/lib/i18n';
import { SITE_URL } from '@/lib/site';

const notoSans = Noto_Sans({
  subsets: ['latin'],
  variable: '--font-noto-sans',
  display: 'swap',
});
const notoDeva = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  variable: '--font-noto-deva',
  display: 'swap',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbf7f0' },
    { media: '(prefers-color-scheme: dark)', color: '#101517' },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'hero' });
  const description = t('subtitle');
  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: `${locale === 'hi' ? 'दवाई साथी' : 'Dawai Saathi'}: ${t('eyebrow')}`,
      template: '%s | Dawai Saathi',
    },
    description,
    applicationName: 'Dawai Saathi',
    alternates: { languages: { hi: '/', en: '/en', 'x-default': '/' } },
    openGraph: {
      type: 'website',
      siteName: 'Dawai Saathi',
      locale: locale === 'hi' ? 'hi_IN' : 'en_IN',
      title: t('title'),
      description,
    },
    twitter: { card: 'summary_large_image', title: t('title'), description },
    robots: { index: true, follow: true },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  // `/admin` and any other first segment must not render the marketing pages as a "locale".
  if (!isLocale((await params).locale)) notFound();
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} className={`${notoSans.variable} ${notoDeva.variable}`}>
      <body className="min-h-dvh">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
