'use client';

import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

export function RawJson({ value }: { value: unknown }) {
  const t = useTranslations('demo.json');
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the text is selectable below.
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-semibold">{t('title')}</h3>
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
          <span aria-live="polite">{copied ? t('copied') : t('copy')}</span>
        </Button>
      </div>
      <pre
        tabIndex={0}
        className="max-h-[32rem] overflow-auto rounded-xl bg-surface-2 p-4 text-xs leading-relaxed"
      >
        <code>{text}</code>
      </pre>
    </div>
  );
}
