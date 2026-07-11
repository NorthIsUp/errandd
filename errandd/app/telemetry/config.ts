// Telemetry configuration resolution.
//
// The ONE place that decides whether OpenTelemetry is on and where it exports.
// Pure + side-effect-free: it reads `settings.otel` and the `ERRANDD_OTEL_*`
// (plus standard `OTEL_EXPORTER_OTLP_*`) env vars and returns a resolved config.
// Nothing here constructs an exporter or touches the OTel SDK — that lives in
// otel.ts and only runs when `enabled` is true. Strict no-op contract: with no
// endpoint and no explicit enable flag, `enabled` is false and the daemon's
// behavior is unchanged.

import type { OtelSettings } from "../config";

/** Fully-resolved telemetry config. `enabled=false` ⇒ every telemetry call is a
 *  no-op and no exporter/provider is ever created. */
export interface OtelConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  /** Emit trace spans via OTLP/HTTP to this endpoint (undefined ⇒ traces off,
   *  unless a span exporter is injected in tests). */
  tracesEndpoint?: string;
  /** Push metrics via OTLP/HTTP to this endpoint on an interval (optional —
   *  Prometheus scrape is the default surface). */
  metricsEndpoint?: string;
  /** Serve a Prometheus `/metrics` scrape endpoint from the daemon's web server. */
  prometheus: boolean;
  /** Optional OTLP headers (e.g. auth), parsed from `OTEL_EXPORTER_OTLP_HEADERS`
   *  (`k1=v1,k2=v2`). */
  headers?: Record<string, string>;
}

function envTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Parse an OTLP header string `k1=v1,k2=v2` into a record (best-effort). */
function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the effective telemetry config from settings + env. Precedence for
 * each value: explicit `ERRANDD_OTEL_*` env → standard `OTEL_*` env →
 * `settings.otel` → default. Telemetry is OFF unless something explicitly turns
 * it on: an explicit enable flag, or the presence of a traces/metrics endpoint.
 */
export function resolveOtelConfig(
  otel: OtelSettings | undefined,
  env: Record<string, string | undefined> = process.env,
): OtelConfig {
  const base = firstNonEmpty(
    env.ERRANDD_OTEL_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otel?.endpoint,
  );
  const tracesEndpoint = firstNonEmpty(
    env.ERRANDD_OTEL_TRACES_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    otel?.tracesEndpoint,
    base,
  );
  const metricsEndpoint = firstNonEmpty(
    env.ERRANDD_OTEL_METRICS_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    otel?.metricsEndpoint,
    // Note: NOT derived from `base` — Prometheus scrape is the default metrics
    // surface, so an OTLP metrics push only happens when explicitly requested.
  );

  const explicitEnable = envTruthy(env.ERRANDD_OTEL_ENABLED) || otel?.enabled === true;
  const explicitDisable =
    env.ERRANDD_OTEL_ENABLED !== undefined && !envTruthy(env.ERRANDD_OTEL_ENABLED);

  // Enabled when explicitly turned on, or when an endpoint is configured — but a
  // hard `ERRANDD_OTEL_ENABLED=0` always wins (kill switch).
  const enabled = !explicitDisable && (explicitEnable || !!tracesEndpoint || !!metricsEndpoint);

  // Prometheus /metrics defaults ON whenever telemetry is enabled (the primary
  // metrics surface), unless explicitly disabled.
  const prometheus =
    enabled &&
    (env.ERRANDD_OTEL_PROMETHEUS !== undefined
      ? envTruthy(env.ERRANDD_OTEL_PROMETHEUS)
      : otel?.prometheus !== false);

  return {
    enabled,
    serviceName: firstNonEmpty(env.ERRANDD_OTEL_SERVICE_NAME, otel?.serviceName) ?? "errandd",
    serviceVersion: firstNonEmpty(env.ERRANDD_OTEL_SERVICE_VERSION) ?? "0.0.0",
    ...(tracesEndpoint ? { tracesEndpoint } : {}),
    ...(metricsEndpoint ? { metricsEndpoint } : {}),
    prometheus,
    ...(parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
      ? { headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) }
      : {}),
  };
}
