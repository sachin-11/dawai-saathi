import {
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { MetricsService, METRIC_LABEL_ALLOWLIST } from './metrics.service';
import { scrubAttributes, valueIsSafe } from './phi-safe';
import { ratioKeeps, ScrubbingExporter, TailSamplingProcessor } from './span-processors';
import { contextFromCarrier, inSpan, markEmergency, withTrace } from './trace-context';
import { failureReason } from './worker-factory.service';

describe('PHI-safe attributes', () => {
  it('keeps allowlisted keys and dawai.* ids, drops everything else', () => {
    expect(
      scrubAttributes({
        'http.method': 'POST',
        'http.url': 'https://s3.example/x?X-Amz-Signature=abc',
        'http.target': '/webhook/whatsapp?token=abc',
        'db.statement': "SELECT * FROM users WHERE phone = '9876543210'",
        'net.peer.ip': '10.0.0.1',
        'dawai.request_id': 'wamid.HBgLOTE5',
        'dawai.trace': '0123456789abcdef0123456789abcdef',
        'dawai.user_id': '3f0b6c1e-8f5d-4d2c-9d4e-6a0a1d7d9e11',
        'dawai.cost_usd': 0.0123,
        'patient.name': 'Ramesh Kumar',
      }),
    ).toEqual({
      'http.method': 'POST',
      'dawai.request_id': 'wamid.HBgLOTE5',
      'dawai.trace': '0123456789abcdef0123456789abcdef',
      'dawai.user_id': '3f0b6c1e-8f5d-4d2c-9d4e-6a0a1d7d9e11',
      'dawai.cost_usd': 0.0123,
    });
  });

  it.each([
    ['a bare phone number', '9876543210'],
    ['a formatted phone number', '+91 98765 43210'],
    ['a phone number inside text', 'call me on 98765 43210 please'],
    ['an e-mail', 'a@b.example'],
    ['a long text', 'x'.repeat(500)],
    ['an object', { a: 1 }],
  ])('rejects %s as a value', (_label, value) => {
    expect(valueIsSafe(value)).toBe(false);
  });

  it('accepts ids that merely contain many digits', () => {
    expect(valueIsSafe('wamid.HBgM1234567890123456')).toBe(true);
    expect(valueIsSafe('00000000000000000000000000000012')).toBe(false); // digits only: phone-like
  });
});

describe('ScrubbingExporter', () => {
  it('strips unknown attributes, events and status text before export', () => {
    const inner = new InMemorySpanExporter();
    const tp = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new ScrubbingExporter(inner))],
    });
    const tracer = tp.getTracer('t');
    const span = tracer.startSpan('op');
    span.setAttribute('dawai.node', 'classify');
    span.setAttribute('user.phone', '9876543210');
    span.recordException(new Error('Ramesh Kumar 9876543210'));
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'failed for Ramesh' });
    span.end();
    const [done] = inner.getFinishedSpans();
    expect(done?.attributes).toEqual({ 'dawai.node': 'classify' });
    expect(done?.events).toEqual([]);
    expect(done?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(done?.name).toBe('op');
    expect(done?.spanContext().traceId).toBeDefined();
  });
});

describe('tail sampling', () => {
  function run(ratio: number, mutate: (root: Span, child: Span) => void): number {
    const sink = new InMemorySpanExporter();
    const tp = new NodeTracerProvider({
      spanProcessors: [new TailSamplingProcessor(new SimpleSpanProcessor(sink), ratio)],
    });
    const tracer = tp.getTracer('t');
    const root = tracer.startSpan('root');
    const child = tracer.startSpan('child', {}, trace.setSpan(context.active(), root));
    mutate(root, child);
    child.end();
    root.end();
    return sink.getFinishedSpans().length;
  }

  it('drops ordinary traces at ratio 0 and keeps all at ratio 1', () => {
    expect(run(0, () => undefined)).toBe(0);
    expect(run(1, () => undefined)).toBe(2);
  });

  it('always keeps a trace with an error or an emergency', () => {
    expect(run(0, (_root, child) => child.setStatus({ code: SpanStatusCode.ERROR }))).toBe(2);
    expect(run(0, (root) => root.setAttribute('dawai.emergency', true))).toBe(2);
  });

  it('gives the same answers as the Python service for the same trace ids', () => {
    // Vectors produced by app.observability.otel.ratio_keeps in the AI service (ratio 0.2 / 0.5).
    const vectors: [string, boolean, boolean][] = [
      ['0af7651916cd43dd8448eb211c80319c', false, false],
      ['4bf92f3577b34da6a3ce929d0e0e4736', false, false],
      ['00000000000000000000000000000001', true, true],
      ['ffffffffffffffffffffffffffffffff', false, false],
      ['aaaaaaaaaaaaaaaa3333333333333333', false, true],
    ];
    for (const [traceId, at20, at50] of vectors) {
      expect(ratioKeeps(traceId, 0.2)).toBe(at20);
      expect(ratioKeeps(traceId, 0.5)).toBe(at50);
    }
  });
});

describe('trace context through a queue job', () => {
  const exporter = new InMemorySpanExporter();
  let tp: NodeTracerProvider;

  beforeAll(() => {
    tp = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    tp.register({ propagator: new W3CTraceContextPropagator() });
  });
  afterAll(async () => {
    await tp.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });
  beforeEach(() => {
    exporter.reset();
  });

  it('one trace id across webhook -> job data -> worker -> AI call', async () => {
    let job: { userId: string; _tp?: string } = { userId: 'u' };
    await inSpan({ name: 'POST /webhook', kind: SpanKind.SERVER }, () => {
      job = withTrace(job); // what InboundQueue.add does
      return Promise.resolve();
    });
    expect(job._tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(JSON.stringify(job)).not.toMatch(/phone|text|body/); // only ids and the traceparent

    await inSpan(
      { name: 'inbound process', kind: SpanKind.CONSUMER, parent: contextFromCarrier(job) },
      async () => {
        await inSpan({ name: 'ai.process', kind: SpanKind.CLIENT }, () => Promise.resolve());
      },
    );
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(
      ['POST /webhook', 'ai.process', 'inbound process'].sort(),
    );
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const worker = spans.find((s) => s.name === 'inbound process');
    const webhook = spans.find((s) => s.name === 'POST /webhook');
    expect(worker?.parentSpanContext?.spanId).toBe(webhook?.spanContext().spanId);
  });

  it('a job without a traceparent starts a fresh trace', async () => {
    await inSpan({ name: 'orphan', parent: contextFromCarrier({}) }, () => Promise.resolve());
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it('marks an emergency on the active span', async () => {
    await inSpan({ name: 'webhook' }, () => {
      markEmergency();
      return Promise.resolve();
    });
    expect(exporter.getFinishedSpans()[0]?.attributes['dawai.emergency']).toBe(true);
  });

  it('records an error on the span and rethrows', async () => {
    await expect(
      inSpan({ name: 'boom' }, () => Promise.reject(new TypeError('secret 9876543210'))),
    ).rejects.toThrow(TypeError);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['error.type']).toBe('TypeError');
  });
});

describe('metrics', () => {
  it('only uses allowlisted label names (no user ids, drug names or text as labels)', async () => {
    const metrics = new MetricsService();
    // Touch every collector once so labelled series exist in the exposition.
    metrics.waInbound.inc({ type: 'text' });
    metrics.waOutbound.inc({ kind: 'text', status: 'sent' });
    metrics.jobFailed.inc({ queue: 'inbound', reason: 'error' });
    metrics.replyLatency.observe({ intent: 'help' }, 120);
    metrics.rateLimited.inc({ scope: 'msg_min' });
    metrics.waQualityState.labels('ok').set(1);
    const used = new Set<string>();
    for (const metric of await metrics.registry.getMetricsAsJSON()) {
      const labelNames = (metric as unknown as { labelNames?: string[] }).labelNames ?? [];
      for (const name of labelNames) used.add(name);
      for (const value of (metric as { values?: { labels: Record<string, unknown> }[] }).values ??
        []) {
        for (const name of Object.keys(value.labels)) used.add(name);
      }
    }
    expect([...used].filter((name) => !METRIC_LABEL_ALLOWLIST.has(name))).toEqual([]);
    expect(used.size).toBeGreaterThan(5);
  });

  it('exposes every metric the brief asks for', async () => {
    const text = await new MetricsService().render();
    for (const name of [
      'wa_inbound_total',
      'wa_outbound_total',
      'wa_api_errors_total',
      'webhook_latency_ms',
      'queue_depth',
      'queue_wait_ms',
      'job_duration_ms',
      'job_failed_total',
      'dlq_size',
      'reply_latency_ms',
      'reminders_sent_total',
      'reminder_ack_total',
      'caregiver_alerts_total',
      'rate_limited_total',
      'budget_state',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  it('pre-creates the series the alerts watch, so the very first event is visible to increase()', async () => {
    const text = await new MetricsService().render();
    expect(text).toMatch(/wa_api_errors_total\{code="190"\} 0/);
    expect(text).toMatch(/emergency_outbound_total\{status="failed"\} 0/);
    expect(text).toMatch(/dlq_moved_total\{queue="inbound"\} 0/);
    expect(text).toMatch(/dlq_moved_total\{queue="user-deletion"\} 0/);
  });

  it('maps failures to a small fixed set of reasons', () => {
    class AiServiceError extends Error {
      override name = 'AiServiceError';
    }
    class Weird extends Error {
      override name = 'SomethingElseEntirely';
    }
    expect(failureReason(new AiServiceError('x'))).toBe('ai_service');
    expect(failureReason(new Weird('x'))).toBe('error');
    expect(failureReason(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
  });
});
