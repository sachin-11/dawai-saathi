'use client';

import {
  Activity,
  BarChart3,
  ClipboardCheck,
  FlaskConical,
  LogOut,
  ScrollText,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/admin', label: 'Overview', icon: BarChart3 },
  { href: '/admin/review', label: 'Review queue', icon: ClipboardCheck },
  { href: '/admin/evals', label: 'Evals', icon: FlaskConical },
  { href: '/admin/prompts', label: 'Prompts', icon: ScrollText },
  { href: '/admin/operations', label: 'Operations', icon: Activity },
] as const;

export function AdminNav({ email }: { email: string }) {
  const pathname = usePathname() ?? '';
  return (
    <aside className="md:sticky md:top-4 md:h-fit md:w-56 md:shrink-0">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-ink"
      >
        Skip to content
      </a>
      <div className="rounded-2xl border border-border bg-surface p-3">
        <p className="px-2 pb-2 text-lg font-extrabold">Dawai Saathi</p>
        <nav aria-label="Admin">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {ITEMS.map(({ href, label, icon: Icon }) => {
              const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-semibold',
                      active ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2',
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="mt-3 border-t border-border pt-3">
          <p className="truncate px-2 text-xs text-muted" title={email}>
            {email}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start"
            onClick={() => signOut({ callbackUrl: '/admin/login' })}
          >
            <LogOut className="size-4" aria-hidden />
            Sign out
          </Button>
        </div>
      </div>
    </aside>
  );
}
