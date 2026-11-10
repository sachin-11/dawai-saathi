import { ErrorNote, PageHeader } from '@/components/admin/ui';
import { Badge } from '@/components/ui/badge';
import type { PromptInfo } from '@/lib/admin-types';
import { adminFetch, currentAdmin } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Prompts' };

export default async function PromptsPage() {
  const email = (await currentAdmin()) ?? '';
  const result = await adminFetch<{ prompts: PromptInfo[] }>(email, '/prompts');
  return (
    <>
      <PageHeader
        title="Prompts"
        description="Versioned prompt files. A prompt is never edited in place."
      />
      <p className="max-w-2xl text-muted">
        A prompt file is never edited: a change creates the next version and needs a passing eval
        report. The highest version of each family is the current one.
      </p>
      {!result.ok ? (
        <ErrorNote result={result} />
      ) : result.data.prompts.length === 0 ? (
        <p className="text-muted">No prompts were synced (run `make admin-data`).</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
          <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
            <caption className="sr-only">Prompt versions</caption>
            <thead>
              <tr className="border-b border-border text-muted">
                {['Prompt id', 'Family', 'Version', 'Status'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-3 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.data.prompts.map((prompt) => (
                <tr key={prompt.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-3 font-mono text-xs">{prompt.id}</td>
                  <td className="px-3 py-3">{prompt.family}</td>
                  <td className="px-3 py-3 tabular-nums">v{prompt.version}</td>
                  <td className="px-3 py-3">
                    <Badge tone={prompt.current ? 'ok' : 'neutral'}>
                      {prompt.current ? 'current' : 'older'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
