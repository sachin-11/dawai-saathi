'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { REVIEW_LABELS, type ReviewItem, type ReviewLabel } from '@/lib/admin-types';

const LABEL_TEXT: Record<ReviewLabel, string> = {
  correct: 'Extraction is correct',
  extraction_wrong: 'Extraction is wrong',
  unreadable: 'Image unreadable',
  not_a_document: 'Not a document',
};

interface Revealed {
  extraction: unknown;
  imageDataUrl: string | null;
}

export const MIN_REASON = 10;

function ReviewDialog({ item, onClose }: { item: ReviewItem; onClose: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(
    action: 'reveal' | 'resolve',
    body: Record<string, string>,
  ): Promise<Response> {
    return fetch(`/api/admin/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, ...body }),
    });
  }

  async function reveal(): Promise<void> {
    setBusy(true);
    setError(null);
    const response = await post('reveal', { reason: reason.trim() }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError('Could not reveal this document. The attempt was not shown.');
      return;
    }
    setRevealed((await response.json()) as Revealed);
  }

  async function resolve(label: ReviewLabel): Promise<void> {
    setBusy(true);
    const response = await post('resolve', { label }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError('Could not save the verdict.');
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
      <DialogTitle className="text-xl font-bold">Document {item.id.slice(0, 8)}</DialogTitle>
      <DialogDescription className="text-sm text-muted">
        {item.kind} · {item.status} · prompt {item.promptVersion ?? 'n/a'} ·{' '}
        {item.warnings.lowConfidenceItems} unclear item(s)
        {item.warnings.critical ? ' · has a critical value' : ''}. Patient details are hidden.
      </DialogDescription>

      {!revealed ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void reveal();
          }}
        >
          <label htmlFor="reason" className="block font-semibold">
            Why do you need to see this document?
          </label>
          <textarea
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={500}
            required
            className="w-full rounded-xl border border-border bg-bg p-3"
            aria-describedby="reason-help"
          />
          <p id="reason-help" className="text-xs text-muted">
            At least {MIN_REASON} characters. Your e-mail, the document and this reason are written
            to the audit log before anything is shown. The picture link is valid for 60 seconds.
          </p>
          <Button type="submit" disabled={busy || reason.trim().length < MIN_REASON}>
            <Eye className="size-4" aria-hidden />
            Reveal with reason
          </Button>
        </form>
      ) : (
        <div className="mt-4 space-y-4" data-testid="revealed">
          {revealed.imageDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing to optimise
            <img
              src={revealed.imageDataUrl}
              alt="The uploaded document"
              className="max-h-80 w-full rounded-lg border border-border object-contain"
            />
          ) : (
            <p className="text-sm text-muted">The picture could not be loaded.</p>
          )}
          <pre tabIndex={0} className="max-h-72 overflow-auto rounded-xl bg-surface-2 p-3 text-xs">
            {JSON.stringify(revealed.extraction, null, 2)}
          </pre>
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-1 text-sm underline"
            onClick={() => setRevealed(null)}
          >
            <EyeOff className="size-4" aria-hidden />
            Hide again
          </button>
        </div>
      )}

      <fieldset className="mt-5 border-t border-border pt-4">
        <legend className="font-semibold">Verdict</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {REVIEW_LABELS.map((label) => (
            <Button
              key={label}
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void resolve(label)}
            >
              {LABEL_TEXT[label]}
            </Button>
          ))}
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
      <DialogClose asChild>
        <Button variant="ghost" className="mt-4">
          Close
        </Button>
      </DialogClose>
    </DialogContent>
  );
}

export function ReviewTable({ items }: { items: ReviewItem[] }) {
  const [open, setOpen] = useState<ReviewItem | null>(null);
  if (items.length === 0) return <p className="text-muted">Nothing to review. 🎉</p>;
  return (
    <>
      <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
        <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
          <caption className="sr-only">Documents waiting for review</caption>
          <thead>
            <tr className="border-b border-border text-muted">
              {['Document', 'Kind', 'Created', 'Confidence', 'Signals', 'Prompt', ''].map((h) => (
                <th key={h} scope="col" className="px-3 py-3 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                className="border-b border-border last:border-0"
                data-testid="review-row"
              >
                <td className="px-3 py-3 font-mono text-xs">{item.id.slice(0, 8)}</td>
                <td className="px-3 py-3">{item.kind}</td>
                <td className="px-3 py-3 tabular-nums">
                  {item.createdAt.slice(0, 16).replace('T', ' ')}
                </td>
                <td className="px-3 py-3 tabular-nums">
                  {item.confidence === null ? 'n/a' : `${Math.round(item.confidence * 100)}%`}
                </td>
                <td className="px-3 py-3">
                  <span className="flex flex-wrap gap-1">
                    {item.warnings.lowConfidenceItems > 0 && (
                      <Badge tone="warn">{item.warnings.lowConfidenceItems} unclear</Badge>
                    )}
                    {item.warnings.critical && <Badge tone="danger">critical</Badge>}
                    {item.reviewLabel && <Badge tone="ok">{item.reviewLabel}</Badge>}
                  </span>
                </td>
                <td className="px-3 py-3 font-mono text-xs">{item.promptVersion ?? 'n/a'}</td>
                <td className="px-3 py-3 text-right">
                  <Button size="sm" variant="secondary" onClick={() => setOpen(item)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={open !== null} onOpenChange={(value) => !value && setOpen(null)}>
        {open && <ReviewDialog item={open} onClose={() => setOpen(null)} />}
      </Dialog>
    </>
  );
}
