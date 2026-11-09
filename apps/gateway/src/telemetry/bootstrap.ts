/**
 * OpenTelemetry bootstrap (M15). Imported FIRST in `main.ts`: the auto-instrumentations patch
 * `http`, `express`, `ioredis`, ... at require time, so this must run before Nest loads them.
 *
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. Records every trace (AlwaysOn); the tail sampler
 * keeps all traces with an error or an emergency and OTEL_SAMPLE_RATIO of the rest; the scrubbing
 * exporter is the last step before export (see phi-safe.ts).
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { loadDotEnv } from '../config/load-dotenv';
import { ScrubbingExporter, TailSamplingProcessor } from './span-processors';

let sdk: NodeSDK | undefined;

export function startTelemetry(env: NodeJS.ProcessEnv = process.env): NodeSDK | undefined {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (!endpoint || sdk) return sdk;
  const ratio = Number(env['OTEL_SAMPLE_RATIO'] ?? '0.2');
  const exporter = new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` });
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': 'gateway',
      'deployment.environment': env['NODE_ENV'] ?? 'development',
    }),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      new TailSamplingProcessor(
        new BatchSpanProcessor(new ScrubbingExporter(exporter)),
        Number.isFinite(ratio) ? ratio : 0.2,
      ),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // one span per route is enough; a span per Express middleware layer only buries the useful ones
        '@opentelemetry/instrumentation-express': {
          ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.REQUEST_HANDLER],
        },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => /^\/(metrics|health)/.test(request.url ?? ''),
        },
      }),
    ],
  });
  sdk.start();
  return sdk;
}

export async function stopTelemetry(): Promise<void> {
  const current = sdk;
  sdk = undefined;
  await current?.shutdown().catch(() => undefined);
}

loadDotEnv();
startTelemetry();
