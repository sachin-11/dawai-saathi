import {
  type Attributes,
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

import { EMERGENCY_ATTRIBUTE, scrubAttributes } from './phi-safe';

/**
 * Trace context through BullMQ (M15). A job carries the W3C `traceparent` of the span that created it
 * in `_tp`: a short opaque string (trace id + span id + flags), no user data. The worker continues the
 * trace from it, so one WhatsApp message is ONE trace across webhook -> queue -> worker -> AI service.
 */
export interface TraceCarrier {
  _tp?: string;
}

const TRACER_NAME = 'dawai.gateway';

export function getTracer(): ReturnType<typeof trace.getTracer> {
  return trace.getTracer(TRACER_NAME);
}

/** Copy of `data` with the active span's `traceparent` attached (unchanged when there is none). */
export function withTrace<T extends object>(data: T): T & TraceCarrier {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const traceparent = carrier['traceparent'];
  return traceparent ? { ...data, _tp: traceparent } : { ...data };
}

/** `traceparent` header for an outgoing HTTP call made inside the active span. */
export function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function contextFromCarrier(data: TraceCarrier | undefined): Context {
  const traceparent = data?._tp;
  if (!traceparent) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, { traceparent });
}

export function currentTraceIds(): { trace_id: string; span_id: string } | undefined {
  const span = trace.getSpan(context.active());
  const ctx = span?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return undefined;
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/** Set `dawai.*` attributes on the active span (scrubbed; a no-op without a recording span). */
export function markSpan(attributes: Record<string, string | number | boolean>): void {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return;
  const prefixed: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) prefixed[`dawai.${key}`] = value;
  for (const [key, value] of Object.entries(scrubAttributes(prefixed)))
    span.setAttribute(key, value);
}

export function markEmergency(): void {
  trace.getActiveSpan()?.setAttribute(EMERGENCY_ATTRIBUTE, true);
}

export interface SpanOptions {
  name: string;
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
  parent?: Context;
}

/** Run `fn` inside a new span (child of `parent` or of the active span); errors mark the span. */
export async function inSpan<T>(options: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
  const parent = options.parent ?? context.active();
  const span = getTracer().startSpan(
    options.name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: scrubAttributes(
        Object.fromEntries(
          Object.entries(options.attributes ?? {}).map(([k, v]) => [
            k.startsWith('dawai.') ? k : `dawai.${k}`,
            v,
          ]),
        ),
      ),
    },
    parent,
  );
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', error instanceof Error ? error.name : 'unknown');
    throw error;
  } finally {
    span.end();
  }
}
