// OpenTelemetry bootstrap — the ONE module that owns the SDK lifecycle.
//
// Contract (req 2 of the observability overhaul):
//  - NO import-time side effects. Importing this module constructs nothing and
//    starts nothing; the OTel classes are imported statically (importing a class
//    is not a side effect), but the SDK is only instantiated inside
//    `initTelemetry` and only when the resolved config says `enabled`.
//  - STRICT no-op when unconfigured. With no OTLP endpoint and no explicit
//    enable flag, `initTelemetry` returns immediately: no exporters, no
//    providers, no timers, zero cost, zero behavior change. Every accessor
//    (`getTracer`, `getMeter`, `getMetricsText`) then returns null.
//
// This module is server-only and is never imported by the browser bundle
// (web/ entrypoints don't reference app/telemetry/*), so the Node OTel SDK
// never reaches the client.

import { metrics as metricsApi, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  type IMetricReader,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { OtelConfig } from "./config";
import { initMetrics, resetMetrics } from "./metrics";

/** Instrumentation scope name for errandd's tracer + meter. */
export const TELEMETRY_SCOPE = "errandd";

/** Test/injection hooks — lets a test wire an in-memory span exporter without
 *  standing up an OTLP endpoint. Never used in production. */
export interface TelemetryOverrides {
  /** Replace the OTLP span exporter with a caller-provided one (in-memory). */
  spanExporter?: SpanExporter;
}

interface TelemetryState {
  sdk: NodeSDK;
  tracer: Tracer;
  meter: Meter;
  prometheus: PrometheusExporter | null;
  spanProcessors: SpanProcessor[];
}

let state: TelemetryState | null = null;

/** True once telemetry is initialized and enabled. */
export function isTelemetryEnabled(): boolean {
  return state !== null;
}

/** The errandd tracer, or null when telemetry is off (callers no-op). */
export function getTracer(): Tracer | null {
  return state?.tracer ?? null;
}

/** The errandd meter, or null when telemetry is off. */
export function getMeter(): Meter | null {
  return state?.meter ?? null;
}

/**
 * Initialize telemetry from a resolved config. Idempotent and strict-no-op:
 * returns immediately (creating nothing) when `cfg.enabled` is false or when a
 * spanExporter override is absent AND no traces endpoint is set AND metrics are
 * off. Safe to call once from start.ts behind config.
 */
export function initTelemetry(cfg: OtelConfig, overrides: TelemetryOverrides = {}): void {
  if (state) return; // already initialized
  if (!cfg.enabled) return; // strict no-op

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_SERVICE_VERSION]: cfg.serviceVersion,
  });

  // --- Span processors -------------------------------------------------------
  const spanProcessors: SpanProcessor[] = [];
  if (overrides.spanExporter) {
    // Test / in-memory: flush synchronously so assertions see spans immediately.
    spanProcessors.push(new SimpleSpanProcessor(overrides.spanExporter));
  } else if (cfg.tracesEndpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${cfg.tracesEndpoint.replace(/\/+$/, "")}/v1/traces`,
          ...(cfg.headers ? { headers: cfg.headers } : {}),
        }),
      ),
    );
  }

  // --- Metric readers --------------------------------------------------------
  const metricReaders: IMetricReader[] = [];
  let prometheus: PrometheusExporter | null = null;
  if (cfg.prometheus) {
    // preventServerStart: we serve /metrics from the daemon's own Bun server
    // (ui/server.ts) via getMetricsText(), not the exporter's built-in http.
    prometheus = new PrometheusExporter({ preventServerStart: true });
    metricReaders.push(prometheus);
  }
  if (cfg.metricsEndpoint) {
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${cfg.metricsEndpoint.replace(/\/+$/, "")}/v1/metrics`,
          ...(cfg.headers ? { headers: cfg.headers } : {}),
        }),
      }),
    );
  }

  const sdk = new NodeSDK({
    resource,
    ...(spanProcessors.length > 0 ? { spanProcessors } : {}),
    ...(metricReaders.length > 0 ? { metricReaders } : {}),
  });
  sdk.start();

  const tracer = trace.getTracer(TELEMETRY_SCOPE);
  const meter = metricsApi.getMeter(TELEMETRY_SCOPE);
  initMetrics(meter);

  state = { sdk, tracer, meter, prometheus, spanProcessors };
}

/** Test-only: flush pending span exports (SimpleSpanProcessor defers to a
 *  microtask) so an in-memory exporter is readable synchronously after. */
export async function flushTelemetryForTest(): Promise<void> {
  if (!state) return;
  await Promise.all(state.spanProcessors.map((p) => p.forceFlush()));
}

/**
 * Serialize the current metric snapshot as Prometheus text exposition, or null
 * when telemetry/Prometheus is disabled (so the /metrics route can 404). Reads
 * the shared PrometheusExporter reader — no separate collection path.
 */
export async function getMetricsText(): Promise<string | null> {
  const prom = state?.prometheus;
  if (!prom) return null;
  const { resourceMetrics, errors } = await prom.collect();
  if (errors.length > 0) {
    // Collection errors are non-fatal — serialize whatever we got.
    console.error(`[errandd] metrics collection errors: ${errors.length}`);
  }
  return new PrometheusSerializer().serialize(resourceMetrics);
}

/** Shut telemetry down + flush exporters. Best-effort; safe when never inited. */
export async function shutdownTelemetry(): Promise<void> {
  if (!state) return;
  const { sdk } = state;
  state = null;
  resetMetrics();
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error(`[errandd] telemetry shutdown error:`, err);
  }
}

/** Test-only: fully reset module state so a fresh initTelemetry can run. */
export async function resetTelemetryForTest(): Promise<void> {
  await shutdownTelemetry();
}
