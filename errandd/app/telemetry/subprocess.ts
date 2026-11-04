import { getSettings } from "../config";
import { resolveOtelConfig, type OtelConfig } from "./config";

function childConfig(env: Record<string, string>): OtelConfig {
  let settings;
  try { settings = getSettings().otel; } catch { /* CLI helpers also run before settings load. */ }
  return resolveOtelConfig(settings, env);
}

/** Settings-backed endpoints must reach children as standard OTel variables. */
export function telemetryChildEnv(env: Record<string, string>, runtime: string): Record<string, string> {
  const cfg = childConfig(env);
  if (!cfg.enabled) return env;
  const out = { ...env, OTEL_SERVICE_NAME: cfg.serviceName };
  if (cfg.tracesEndpoint) {
    Object.assign(out, {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: cfg.tracesEndpoint,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      OTEL_TRACES_EXPORTER: "otlp",
    });
  }
  if (cfg.metricsEndpoint) {
    Object.assign(out, {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: cfg.metricsEndpoint,
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
      OTEL_METRICS_EXPORTER: "otlp",
    });
  }
  if (runtime === "claude") {
    Object.assign(out, { CLAUDE_CODE_ENABLE_TELEMETRY: "1" });
    if (cfg.tracesEndpoint) Object.assign(out, { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1" });
    if (env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
      Object.assign(out, { OTEL_LOGS_EXPORTER: "otlp" });
    }
  }
  return out;
}

/** Codex selects its native exporter through TOML overrides, not env alone. */
export function codexTelemetryArgs(args: string[], env: Record<string, string>): string[] {
  const cfg = childConfig(env);
  if (!cfg.enabled || !cfg.tracesEndpoint) return args;
  const headers = Object.entries({ ...cfg.headers, ...cfg.tracesHeaders })
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",");
  const exporter = `{otlp-http={endpoint=${JSON.stringify(cfg.tracesEndpoint)},protocol="binary",headers={${headers}}}}`;
  // Put global config before `exec` so fresh sessions and resumes both receive it.
  return [args[0], "-c", `otel.trace_exporter=${exporter}`, ...args.slice(1)];
}
