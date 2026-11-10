import type { Metadata, Viewport } from 'next';
import { Noto_Sans } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import '../globals.css';

const notoSans = Noto_Sans({ subsets: ['latin'], variable: '--font-noto-sans', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s | Dawai Saathi admin' },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function AdminRootLayout({ children }: { children: ReactNode }) {
  const saved = (await cookies()).get('admin-theme')?.value;
  const theme = saved === 'light' || saved === 'dark' ? saved : undefined;
  return (
    <html lang="en" className={notoSans.variable} data-theme={theme}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
