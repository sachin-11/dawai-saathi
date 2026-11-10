'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

export type ThemeChoice = 'system' | 'light' | 'dark';

const OPTIONS = [
  { value: 'system', label: 'System theme', icon: Monitor },
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
] as const;

/** The choice lives in a cookie, so the server renders the right theme with no flash and no inline script. */
export function ThemeToggle({ initial, className }: { initial: ThemeChoice; className?: string }) {
  const [theme, setTheme] = useState<ThemeChoice>(initial);

  function choose(next: ThemeChoice): void {
    setTheme(next);
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    document.cookie = `admin-theme=${next}; path=/admin; max-age=31536000; samesite=lax`;
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn('inline-flex rounded-xl bg-surface-2 p-1', className)}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => choose(value)}
          className={cn(
            'grid size-9 place-items-center rounded-lg transition-colors',
            theme === value ? 'bg-surface text-primary shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}
