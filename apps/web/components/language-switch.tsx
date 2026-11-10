'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** The same page in the other language: `/x` <-> `/en/x`. */
export function otherLanguagePath(pathname: string): string {
  if (pathname === '/en') return '/';
  if (pathname.startsWith('/en/')) return pathname.slice(3);
  return pathname === '/' ? '/en' : `/en${pathname}`;
}

export function LanguageSwitch({ label, ariaLabel }: { label: string; ariaLabel: string }) {
  const pathname = usePathname() ?? '/';
  const other = pathname.startsWith('/en') ? 'hi' : 'en';
  return (
    <Link
      href={otherLanguagePath(pathname)}
      hrefLang={other}
      lang={other}
      aria-label={ariaLabel}
      className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
    >
      {label}
    </Link>
  );
}
