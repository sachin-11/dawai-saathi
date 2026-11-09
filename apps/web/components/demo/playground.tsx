'use client';

import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, FileUp, Loader2, ShieldAlert } from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DemoErrorBody, DemoErrorCode, DemoResult } from '@/lib/demo-types';
import { prepareUpload, UploadRejected } from '@/lib/downscale';
import { cn } from '@/lib/utils';
import { ExtractionView } from './extraction-view';
import { GenericsView, WarningsView } from './generics-warnings';
import { RawJson } from './raw-json';
import { TraceView } from './trace-view';
import { Turnstile, type TurnstileHandle } from './turnstile';
import { WhatsappPreview } from './whatsapp-preview';

export const SAMPLE_IDS = [
  'rx_clean',
  'rx_messy',
  'rx_duplicate_paracetamol',
  'rx_generic_savings',
  'lab_critical',
  'lab_normal',
  'rx_unreadable',
  'rx_injection',
] as const;
type SampleId = (typeof SAMPLE_IDS)[number];
type Lang = 'hi' | 'en';

class DemoRequestError extends Error {
  constructor(
    readonly code: DemoErrorCode | 'unknown',
    readonly retryAfterS?: number,
  ) {
    super(code);
  }
}

type Source = { kind: 'sample'; id: SampleId } | { kind: 'upload'; file: File };

async function callDemo(
  source: Source,
  language: Lang,
  token: string | undefined,
): Promise<DemoResult> {
  const form = new FormData();
  form.set('language', language);
  if (source.kind === 'sample') form.set('sample_id', source.id);
  else {
    form.set('file', source.file);
    if (token) form.set('turnstile_token', token);
  }
  let response: Response;
  try {
    response = await fetch('/api/demo', { method: 'POST', body: form });
  } catch {
    throw new DemoRequestError('gateway_unavailable');
  }
  const body = (await response.json().catch(() => null)) as
    (DemoResult & Partial<DemoErrorBody>) | null;
  if (!response.ok || !body || body.error) {
    throw new DemoRequestError(body?.error?.code ?? 'unknown', body?.error?.retry_after_s);
  }
  return body;
}

function PlaygroundInner({
  defaultLanguage,
  turnstileSiteKey,
  nonce,
}: {
  defaultLanguage: Lang;
  turnstileSiteKey: string | undefined;
  nonce: string | undefined;
}) {
  const t = useTranslations('demo');
  const [acknowledged, setAcknowledged] = useState(false);
  const [language, setLanguage] = useState<Lang>(defaultLanguage);
  const [source, setSource] = useState<Source | null>(null);
  const [localError, setLocalError] = useState<DemoErrorCode | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const status = useQuery({
    queryKey: ['demo-status'],
    queryFn: async () => {
      const response = await fetch('/api/demo');
      if (!response.ok) throw new Error('status');
      return (await response.json()) as { uploads_enabled: boolean; samples: { id: string }[] };
    },
    staleTime: 60_000,
    retry: false,
  });
  const uploadsEnabled = status.data?.uploads_enabled ?? true;

  const run = useMutation<DemoResult, DemoRequestError, { source: Source; language: Lang }>({
    mutationFn: async ({ source: next, language: lang }) => {
      const token = next.kind === 'upload' ? await turnstile.current?.getToken() : undefined;
      return callDemo(next, lang, token);
    },
  });

  function start(next: Source, lang: Lang): void {
    setLocalError(null);
    setSource(next);
    run.mutate({ source: next, language: lang });
  }

  async function onFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      start({ kind: 'upload', file: await prepareUpload(file) }, language);
    } catch (error) {
      setLocalError(error instanceof UploadRejected ? error.reason : 'bad_request');
    }
  }

  function changeLanguage(next: Lang): void {
    setLanguage(next);
    if (source && !run.isPending) start(source, next);
  }

  const error = localError ?? run.error?.code ?? null;
  const retryAfterS = run.error?.retryAfterS;
  const result = run.data;
  const uploadsBlocked = !acknowledged || !uploadsEnabled || run.isPending;

  return (
    <div className="space-y-8">
      <div
        role="note"
        className="flex gap-3 rounded-2xl border-2 border-accent bg-accent-soft p-4 sm:p-5"
      >
        <ShieldAlert className="mt-1 size-6 shrink-0 text-accent" aria-hidden />
        <div className="space-y-3">
          <p className="text-lg font-bold">{t('notice')}</p>
          <label className="flex cursor-pointer items-start gap-3">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(value) => setAcknowledged(value === true)}
              aria-label={t('noticeAck')}
            />
            <span className="pt-0.5">{t('noticeAck')}</span>
          </label>
        </div>
      </div>

      <section aria-labelledby="samples-h">
        <h2 id="samples-h" className="text-xl font-bold">
          {t('samplesTitle')}
        </h2>
        <p className="text-muted">{t('samplesHint')}</p>
        <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {SAMPLE_IDS.map((id) => {
            const selected = source?.kind === 'sample' && source.id === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  data-testid={`sample-${id}`}
                  disabled={run.isPending}
                  aria-pressed={selected}
                  onClick={() => start({ kind: 'sample', id }, language)}
                  className={cn(
                    'flex h-full w-full flex-col overflow-hidden rounded-xl border-2 bg-surface text-left transition-colors hover:border-primary disabled:opacity-60',
                    selected ? 'border-primary' : 'border-border',
                  )}
                >
                  <Image
                    src={`/samples/${id}.jpg`}
                    alt=""
                    width={400}
                    height={300}
                    unoptimized
                    className="h-28 w-full bg-surface-2 object-cover object-top"
                  />
                  <span className="space-y-1 p-3">
                    <span className="block font-semibold leading-snug">
                      {t(`sampleNames.${id}`)}
                    </span>
                    <span className="block text-xs text-muted">{t(`sampleHints.${id}`)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="upload-h">
        <h2 id="upload-h" className="text-xl font-bold">
          {t('uploadTitle')}
        </h2>
        <div
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (!uploadsBlocked) void onFile(event.dataTransfer.files[0]);
          }}
          className={cn(
            'mt-3 flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center',
            uploadsBlocked ? 'border-border bg-surface-2' : 'border-primary',
          )}
        >
          <FileUp className="size-8 text-primary" aria-hidden />
          <p>{t('dropHint')}</p>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="sr-only"
            data-testid="file-input"
            aria-label={t('chooseFile')}
            disabled={uploadsBlocked}
            onChange={(event) => {
              void onFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <Button
            variant="secondary"
            disabled={uploadsBlocked}
            onClick={() => fileInput.current?.click()}
          >
            {t('chooseFile')}
          </Button>
          {!acknowledged && <p className="text-sm text-muted">{t('needAck')}</p>}
          {acknowledged && !uploadsEnabled && (
            <p className="text-sm font-semibold text-warn">{t('uploadsOff')}</p>
          )}
          <Turnstile ref={turnstile} siteKey={turnstileSiteKey} nonce={nonce} />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3" role="group" aria-label={t('language')}>
        <span className="font-semibold">{t('language')}:</span>
        {(['hi', 'en'] as const).map((lang) => (
          <Button
            key={lang}
            size="sm"
            variant={language === lang ? 'primary' : 'secondary'}
            aria-pressed={language === lang}
            onClick={() => changeLanguage(lang)}
          >
            {lang === 'hi' ? t('languageHi') : t('languageEn')}
          </Button>
        ))}
      </div>

      <div aria-live="polite" role="status" className="min-h-6" data-testid="status">
        {run.isPending && (
          <p className="flex items-center gap-2 font-semibold text-primary">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            {t('running')}
          </p>
        )}
        {result && !run.isPending && <span className="sr-only">{t('ready')}</span>}
      </div>

      {error && !run.isPending && (
        <div
          role="alert"
          className="flex gap-3 rounded-xl border border-danger bg-danger-soft p-4 text-danger"
        >
          <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>
            {t(`errors.${error}` as 'errors.unknown')}
            {error === 'rate_limited' && retryAfterS
              ? ` ${t('errors.retryIn', { minutes: Math.max(1, Math.ceil(retryAfterS / 60)) })}`
              : ''}
          </p>
        </div>
      )}

      {result && !run.isPending && !error && <Results result={result} source={source} />}
    </div>
  );
}

function Results({ result, source }: { result: DemoResult; source: Source | null }) {
  const t = useTranslations('demo');
  const preview = (
    <WhatsappPreview
      reply={result.reply}
      time={t('preview.time')}
      title={t('preview.title')}
      buttonsLabel={t('preview.buttons')}
    />
  );
  return (
    <section
      aria-label={t('ready')}
      className="grid gap-6 lg:grid-cols-[22rem_1fr]"
      data-testid="results"
    >
      <div className="hidden lg:block">
        <div className="sticky top-4 space-y-3">
          <h2 className="font-bold">{t('preview.title')}</h2>
          {preview}
        </div>
      </div>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={result.cached ? 'primary' : 'accent'}>
            {result.cached ? t('cached') : t('live')}
          </Badge>
          {result.meta.model && (
            <span className="text-xs text-muted">
              {t('modelLabel')}: <span className="font-mono">{result.meta.model}</span> ·{' '}
              <span className="font-mono">{result.meta.prompt_version}</span>
            </span>
          )}
          {source?.kind === 'sample' && result.cached && (
            <span className="text-xs text-muted">{t('cachedHint')}</span>
          )}
        </div>
        <Card className="p-3 sm:p-5">
          <Tabs defaultValue="extraction">
            <TabsList aria-label={t('title')}>
              <TabsTrigger value="preview" className="lg:hidden">
                {t('tabs.preview')}
              </TabsTrigger>
              <TabsTrigger value="extraction">{t('tabs.extraction')}</TabsTrigger>
              <TabsTrigger value="generics">{t('tabs.generics')}</TabsTrigger>
              <TabsTrigger value="warnings">
                {t('tabs.warnings')}
                {result.warnings.length > 0 ? ` (${result.warnings.length})` : ''}
              </TabsTrigger>
              <TabsTrigger value="trace">{t('tabs.trace')}</TabsTrigger>
              <TabsTrigger value="json">{t('tabs.json')}</TabsTrigger>
            </TabsList>
            <TabsContent value="preview" className="lg:hidden">
              {preview}
            </TabsContent>
            <TabsContent value="extraction">
              <ExtractionView extraction={result.extraction} />
            </TabsContent>
            <TabsContent value="generics">
              <GenericsView extraction={result.extraction} />
            </TabsContent>
            <TabsContent value="warnings">
              <WarningsView warnings={result.warnings} />
            </TabsContent>
            <TabsContent value="trace">
              <TraceView trace={result.debug_trace} />
            </TabsContent>
            <TabsContent value="json">
              <RawJson
                value={{
                  intent: result.intent,
                  extraction: result.extraction,
                  warnings: result.warnings,
                  meta: result.meta,
                  debug_trace: result.debug_trace,
                }}
              />
            </TabsContent>
          </Tabs>
        </Card>
      </div>
    </section>
  );
}

export function Playground(props: {
  defaultLanguage: Lang;
  turnstileSiteKey: string | undefined;
  nonce: string | undefined;
}) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <PlaygroundInner {...props} />
    </QueryClientProvider>
  );
}
