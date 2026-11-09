import {
  AlarmClock,
  BellRing,
  FlaskConical,
  Languages,
  PiggyBank,
  ScanText,
  ShieldCheck,
  Siren,
  Stethoscope,
  Mic,
  Lock,
  GitBranch,
  Camera,
  MessageCircleHeart,
  EyeOff,
  MapPin,
} from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { GraphDiagram } from '@/components/graph-diagram';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import evalSummary from '@/lib/generated/eval-summary.json';
import { isLocale, localePath } from '@/lib/i18n';
import { GITHUB_URL, WHATSAPP_QR_SVG, WHATSAPP_URL } from '@/lib/site';
import { cn } from '@/lib/utils';

const STACK = [
  'NestJS',
  'BullMQ',
  'FastAPI',
  'LangGraph',
  'PostgreSQL + pg_trgm',
  'Redis',
  'Pinecone',
  'Presidio',
  'OpenTelemetry',
  'Next.js 15',
];

const FEATURE_ICONS = [
  ScanText,
  PiggyBank,
  FlaskConical,
  AlarmClock,
  BellRing,
  Stethoscope,
  Mic,
  Lock,
];
const SAFETY_ICONS = [Stethoscope, Siren, EyeOff, ShieldCheck, MapPin];

function Section({
  id,
  title,
  children,
  tone,
}: {
  id: string;
  title: string;
  children: ReactNode;
  tone?: 'plain' | 'soft';
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className={tone === 'soft' ? 'bg-surface-2 py-14' : 'py-14'}
    >
      <div className="mx-auto max-w-6xl px-4">
        <h2 id={`${id}-h`} className="mb-8 max-w-3xl text-2xl font-bold leading-tight sm:text-3xl">
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}

interface Pair {
  problem: string;
  solution: string;
}
interface Titled {
  title: string;
  text: string;
}
interface Faq {
  q: string;
  a: string;
}

export default async function LandingPage() {
  const rawLocale = await getLocale();
  const locale = isLocale(rawLocale) ? rawLocale : 'hi';
  const [hero, problems, how, features, safety, eng, faq, common] = await Promise.all([
    getTranslations('hero'),
    getTranslations('problems'),
    getTranslations('how'),
    getTranslations('features'),
    getTranslations('safety'),
    getTranslations('engineers'),
    getTranslations('faq'),
    getTranslations('common'),
  ]);
  const demoHref = localePath(locale, '/demo');
  const faqItems = faq.raw('items') as Faq[];
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };

  return (
    <>
      {/* 1. Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 md:grid-cols-[1.4fr_1fr] md:py-20">
        <div className="space-y-6">
          <Badge tone="primary" className="text-sm">
            {hero('eyebrow')}
          </Badge>
          <h1 className="text-3xl font-extrabold leading-tight sm:text-5xl">{hero('title')}</h1>
          <p className="max-w-xl text-lg text-muted">{hero('subtitle')}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <a
              href={WHATSAPP_URL}
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: 'lg' }))}
              data-testid="cta-whatsapp"
            >
              <MessageCircleHeart className="size-5" aria-hidden />
              {common('startWhatsapp')}
            </a>
            <a
              href={demoHref}
              className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }))}
              data-testid="cta-demo"
            >
              {common('openDemo')}
            </a>
          </div>
          <ul className="space-y-2 text-sm text-muted">
            {(hero.raw('trust') as string[]).map((item) => (
              <li key={item} className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <Card className="mx-auto w-full max-w-xs text-center">
          <div
            role="img"
            aria-label={hero('qrAlt')}
            className="mx-auto w-48 rounded-xl bg-white p-2 [&>svg]:h-auto [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: WHATSAPP_QR_SVG }}
          />
          <p className="mt-3 text-sm text-muted">{hero('qrCaption')}</p>
        </Card>
      </section>

      {/* 2. Problem -> solution */}
      <Section id="problems" title={problems('title')} tone="soft">
        <ul className="grid gap-4 md:grid-cols-2">
          {(problems.raw('items') as Pair[]).map((item, index) => (
            <li key={index}>
              <Card className="h-full space-y-3">
                <p className="font-semibold text-accent">{item.problem}</p>
                <p>{item.solution}</p>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      {/* 3. How it works */}
      <Section id="how" title={how('title')}>
        <div className="grid items-center gap-10 md:grid-cols-[1.2fr_1fr]">
          <ol className="space-y-5">
            {(how.raw('steps') as Titled[]).map((step, index) => (
              <li key={index} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-lg font-bold text-primary-ink">
                  {index + 1}
                </span>
                <div>
                  <h3 className="text-lg font-semibold">{step.title}</h3>
                  <p className="text-muted">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div
            className="mx-auto w-full max-w-xs rounded-[2rem] border-4 border-ink/80 bg-wa-bg p-3 shadow-lg"
            aria-hidden
          >
            <div className="mb-2 flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-primary-ink">
              <Camera className="size-4" />
              <span className="text-sm font-semibold">Dawai Saathi</span>
            </div>
            <div className="rounded-xl rounded-tl-none bg-wa-bubble p-3 text-sm text-wa-ink shadow-sm">
              <p className="font-bold">{how('phoneTitle')}</p>
              <p>{how('phoneBody')}</p>
            </div>
          </div>
        </div>
      </Section>

      {/* 4. Features */}
      <Section id="features" title={features('title')} tone="soft">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(features.raw('items') as Titled[]).map((item, index) => {
            const Icon = FEATURE_ICONS[index] ?? Languages;
            return (
              <li key={index}>
                <Card className="h-full space-y-2">
                  <Icon className="size-6 text-primary" aria-hidden />
                  <h3 className="font-semibold">{item.title}</h3>
                  <p className="text-sm text-muted">{item.text}</p>
                </Card>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* 5. Safety and privacy */}
      <Section id="safety" title={safety('title')}>
        <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {(safety.raw('items') as Titled[]).map((item, index) => {
            const Icon = SAFETY_ICONS[index] ?? ShieldCheck;
            return (
              <li key={index}>
                <Card className="h-full space-y-2 border-l-4 border-l-primary">
                  <Icon className="size-6 text-primary" aria-hidden />
                  <h3 className="font-semibold">{item.title}</h3>
                  <p className="text-sm text-muted">{item.text}</p>
                </Card>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* 6. For engineers */}
      <Section id="engineers" title={eng('title')} tone="soft">
        <p className="mb-8 max-w-3xl text-lg text-muted">{eng('intro')}</p>
        <h3 className="mb-3 text-xl font-semibold">{eng('archTitle')}</h3>
        <GraphDiagram label={eng('archTitle')} />
        <p className="mt-2 text-sm text-muted">{eng('archCaption')}</p>

        <div className="mt-10 grid gap-8 md:grid-cols-2">
          <div>
            <h3 className="mb-3 text-xl font-semibold">{eng('stackTitle')}</h3>
            <ul className="flex flex-wrap gap-2">
              {STACK.map((item) => (
                <li key={item}>
                  <Badge tone="neutral" className="text-sm">
                    {item}
                  </Badge>
                </li>
              ))}
            </ul>
            <a
              href={GITHUB_URL}
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'secondary' }), 'mt-5')}
            >
              <GitBranch className="size-5" aria-hidden />
              {eng('github')}
            </a>
          </div>
          <Card>
            <h3 className="mb-3 text-xl font-semibold">{eng('evalTitle')}</h3>
            {evalSummary.available && 'totals' in evalSummary ? (
              <>
                <dl className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <dt className="text-xs text-muted">{eng('evalGates')}</dt>
                    <dd className="text-2xl font-extrabold text-ok">
                      {evalSummary.totals.hardGatesPassed}/{evalSummary.totals.hardGatesTotal}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{eng('evalCases')}</dt>
                    <dd className="text-2xl font-extrabold">{evalSummary.totals.cases}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{eng('evalSuites')}</dt>
                    <dd className="text-2xl font-extrabold">{evalSummary.totals.suites}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted">
                  {evalSummary.date} · {evalSummary.sha} · {evalSummary.scope}
                </p>
                <p className="mt-2 text-sm text-muted">{eng('evalNote')}</p>
              </>
            ) : (
              <p className="text-muted">{eng('evalUnavailable')}</p>
            )}
          </Card>
        </div>
      </Section>

      {/* 7. FAQ */}
      <Section id="faq" title={faq('title')}>
        <div className="max-w-3xl space-y-3">
          {faqItems.map((item, index) => (
            <details
              key={index}
              className="group rounded-xl border border-border bg-surface p-4 open:shadow-sm"
            >
              <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
                {item.q}
              </summary>
              <p className="mt-2 text-muted">{item.a}</p>
            </details>
          ))}
        </div>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd).replace(/</g, '\\u003c') }}
        />
      </Section>
    </>
  );
}
