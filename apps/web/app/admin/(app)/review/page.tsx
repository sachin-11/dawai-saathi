import Link from 'next/link';

import { ReviewTable } from '@/components/admin/review-table';
import { ErrorNote, PageHeader } from '@/components/admin/ui';
import { buttonVariants } from '@/components/ui/button';
import type { ReviewQueuePage } from '@/lib/admin-types';
import { adminFetch, currentAdmin } from '@/lib/gateway';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Review queue' };

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; all?: string }>;
}) {
  const { cursor, all } = await searchParams;
  const includeReviewed = all === '1';
  const email = (await currentAdmin()) ?? '';
  const query = new URLSearchParams({ limit: '25', include_reviewed: String(includeReviewed) });
  if (cursor) query.set('cursor', cursor);
  const result = await adminFetch<ReviewQueuePage>(email, `/review-queue?${query.toString()}`);

  return (
    <>
      <PageHeader title="Review queue">
        <Link
          href={includeReviewed ? '/admin/review' : '/admin/review?all=1'}
          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
        >
          {includeReviewed ? 'Hide reviewed' : 'Show reviewed too'}
        </Link>
      </PageHeader>
      <p className="max-w-2xl text-muted">
        Documents the model was unsure about. Patient content is hidden: open a row and give a
        reason to see it. Every reveal is written to the audit log.
      </p>
      {!result.ok ? (
        <ErrorNote result={result} />
      ) : (
        <>
          <ReviewTable items={result.data.items} />
          {result.data.nextCursor && (
            <Link
              href={`/admin/review?${new URLSearchParams({ cursor: result.data.nextCursor, ...(includeReviewed ? { all: '1' } : {}) }).toString()}`}
              className={cn(buttonVariants({ variant: 'secondary' }))}
            >
              Next page
            </Link>
          )}
        </>
      )}
    </>
  );
}
