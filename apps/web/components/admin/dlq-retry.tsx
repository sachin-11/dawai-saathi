'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

export function DlqRetryButton({ queue, jobId }: { queue: string; jobId: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  async function retry(): Promise<void> {
    setState('busy');
    const response = await fetch('/api/admin/dlq-retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue, jobId }),
    }).catch(() => null);
    setState(response?.ok ? 'done' : 'failed');
    if (response?.ok) router.refresh();
  }
  return (
    <span aria-live="polite">
      <Button
        size="sm"
        variant="secondary"
        disabled={state === 'busy' || state === 'done'}
        onClick={() => void retry()}
      >
        {state === 'done' ? 'Retried' : state === 'failed' ? 'Failed, retry again' : 'Retry'}
      </Button>
    </span>
  );
}
