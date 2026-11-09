import type { Metadata, Viewport } from 'next';
import { Noto_Sans } from 'next/font/google';
import type { ReactNode } from 'react';

import '../globals.css';

const notoSans = Noto_Sans({ subsets: ['latin'], variable: '--font-noto-sans', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s | Dawai Saathi admin' },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={notoSans.variable}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
