// Telemetry public surface. Server-only — never imported by the browser bundle.
//
// Everything here is strict-no-op when telemetry is unconfigured: initTelemetry
// creates nothing, startRunSpan returns a no-op handle, recordRunMetrics/log are
// cheap no-ops, and getMetricsText returns null.

export { resolveOtelConfig, type OtelConfig } from "./config";
export {
  flushTelemetryForTest,
  getMeter,
  getMetricsText,
  getTracer,
  initTelemetry,
  isTelemetryEnabled,
  resetTelemetryForTest,
  shutdownTelemetry,
  type TelemetryOverrides,
} from "./otel";
export {
  recordRunMetrics,
  registerQueueDepthProvider,
  type RunMetricAttrs,
  type RunOutcome,
} from "./metrics";
export {
  parseTraceparent,
  recordWebhookSpan,
  startRunSpan,
  type RunSpanHandle,
  type RunSpanResult,
  type StartRunSpanOpts,
} from "./spans";
export { log, type LogFields } from "./logger";
