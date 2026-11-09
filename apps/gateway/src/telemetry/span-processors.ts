import { SpanStatusCode } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { EMERGENCY_ATTRIBUTE, scrubAttributes } from './phi-safe';

/** Wraps a real exporter: every span is rebuilt with scrubbed attributes, no events, no status text. */
export class ScrubbingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans.map(scrubbedSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export function scrubbedSpan(span: ReadableSpan): ReadableSpan {
  const status = span.status.message
    ? { code: span.status.code } // the message may quote an error
    : span.status;
  return Object.create(span, {
    attributes: { value: scrubAttributes(span.attributes) },
    events: { value: [] }, // exception events carry messages and stack traces
    status: { value: status },
  }) as ReadableSpan;
}

/** Deterministic: the same trace id gives the same answer in every service (see the Python twin). */
export function ratioKeeps(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  // Low 64 bits of the id, as a fraction of 2^64 (Python: (id & (2^64-1)) / 2^64).
  const low = BigInt(`0x${traceId.slice(-16)}`);
  return Number(low) / 2 ** 64 < ratio;
}

function isImportant(span: ReadableSpan): boolean {
  return span.status.code === SpanStatusCode.ERROR || span.attributes[EMERGENCY_ATTRIBUTE] === true;
}

/** Buffers the spans of a trace until its local root ends, then keeps or drops them together. */
export class TailSamplingProcessor implements SpanProcessor {
  private readonly buffers = new Map<string, { startedAt: number; spans: ReadableSpan[] }>();

  constructor(
    private readonly inner: SpanProcessor,
    private readonly ratio: number,
    private readonly maxTraces = 2000,
    private readonly maxAgeMs = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  onStart(): void {
    // nothing: the decision is made when the trace is complete
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    const isLocalRoot =
      span.parentSpanContext === undefined || span.parentSpanContext.isRemote === true;
    const entry = this.buffers.get(traceId) ?? { startedAt: this.now(), spans: [] };
    entry.spans.push(span);
    this.buffers.set(traceId, entry);
    if (isLocalRoot) {
      this.buffers.delete(traceId);
      this.decide(traceId, entry.spans);
    }
    this.evict();
  }

  private evict(): void {
    const now = this.now();
    for (const [traceId, entry] of this.buffers) {
      if (this.buffers.size <= this.maxTraces && now - entry.startedAt <= this.maxAgeMs) break;
      this.buffers.delete(traceId);
      this.decide(traceId, entry.spans);
    }
  }

  private decide(traceId: string, spans: ReadableSpan[]): void {
    if (ratioKeeps(traceId, this.ratio) || spans.some(isImportant)) {
      for (const span of spans) this.inner.onEnd(span);
    }
  }

  async shutdown(): Promise<void> {
    for (const [traceId, entry] of this.buffers) this.decide(traceId, entry.spans);
    this.buffers.clear();
    await this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
}
