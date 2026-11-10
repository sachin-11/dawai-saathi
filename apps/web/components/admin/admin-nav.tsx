'use client';

import {
  Activity,
  BarChart3,
  ClipboardCheck,
  FlaskConical,
  HeartPulse,
  LogOut,
  ScrollText,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';

import { ThemeToggle, type ThemeChoice } from '@/components/admin/theme-toggle';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Monitor',
    items: [
      { href: '/admin', label: 'Overview', icon: BarChart3 },
      { href: '/admin/operations', label: 'Operations', icon: Activity },
    ],
  },
  {
    title: 'Quality',
    items: [
      { href: '/admin/review', label: 'Review queue', icon: ClipboardCheck },
      { href: '/admin/evals', label: 'Evals', icon: FlaskConical },
      { href: '/admin/prompts', label: 'Prompts', icon: ScrollText },
    ],
  },
];

const ALL_ITEMS = GROUPS.flatMap((group) => group.items);

function isActive(pathname: string, href: string): boolean {
  return href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
}

function Brand() {
  return (
    <Link href="/admin" className="flex items-center gap-2.5 rounded-lg">
      <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-ink">
        <HeartPulse className="size-5" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-base font-extrabold">Dawai Saathi</span>
        <span className="block text-xs font-medium text-muted">Admin</span>
      </span>
    </Link>
  );
}

function SignOutButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: '/admin/login' })}
      className={cn(
        'inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-ink hover:bg-surface-2',
        className,
      )}
    >
      <LogOut className="size-4" aria-hidden />
      Sign out
    </button>
  );
}

/** Desktop: a full-height sidebar. Phone: a slim top bar plus a bottom tab bar. One component, so the two stay in step. */
export function AdminShellNav({ email, theme }: { email: string; theme: ThemeChoice }) {
  const pathname = usePathname() ?? '';
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-ink"
      >
        Skip to content
      </a>

      {/* ---- desktop sidebar ---- */}
      <aside className="hidden md:sticky md:top-0 md:flex md:h-dvh md:w-64 md:shrink-0 md:flex-col md:gap-6 md:border-r md:border-border md:bg-surface md:p-4">
        <Brand />
        <nav aria-label="Admin" className="flex-1 space-y-5 overflow-y-auto">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <p className="px-3 pb-1.5 text-xs font-bold tracking-wider text-muted uppercase">
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {group.items.map(({ href, label, icon: Icon }) => {
                  const active = isActive(pathname, href);
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors',
                          active ? 'bg-primary-soft text-primary' : 'text-ink hover:bg-surface-2',
                        )}
                      >
                        <Icon className="size-[18px]" aria-hidden />
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate px-1 text-xs text-muted" title={email}>
              {email}
            </p>
            <ThemeToggle initial={theme} className="shrink-0" />
          </div>
          <SignOutButton className="w-full" />
        </div>
      </aside>

      {/* ---- phone top bar ---- */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-surface px-4 py-2.5 md:hidden">
        <Brand />
        <div className="flex items-center gap-1">
          <ThemeToggle initial={theme} />
          <SignOutButton className="px-2" />
        </div>
      </header>

      {/* ---- phone tab bar ---- */}
      <nav
        aria-label="Admin"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="grid grid-cols-5">
          {ALL_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] leading-tight font-semibold',
                    active ? 'text-primary' : 'text-muted',
                  )}
                >
                  <span
                    className={cn(
                      'grid h-7 w-12 place-items-center rounded-full transition-colors',
                      active && 'bg-primary-soft',
                    )}
                  >
                    <Icon className="size-[18px]" aria-hidden />
                  </span>
                  <span className="max-w-full truncate">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
