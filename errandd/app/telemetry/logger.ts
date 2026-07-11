// Thin structured logger — the migration seam for errandd's ~328 `console.*`
// calls (req 6). It writes the SAME human-readable `[ts] message` line the code
// already emits, then appends a compact ` {json}` of structured fields, and
// auto-injects `trace_id` (from the active OTel span, when telemetry is on) and
// `session_id` (when the caller provides it). When telemetry is off, trace_id is
// simply absent — the line still renders, so this is safe to adopt incrementally.
//
// Only the run/hook LIFECYCLE hot paths are routed through this so far (see the
// runner + hook drain). The remaining `console.*` calls are intentionally left
// as-is; migrate them opportunistically by swapping `console.x(\`[${ts()}] …\`)`
// for `log.x("…", { … })`. pino or an OTel-logs bridge can slot in behind this
// same interface without touching call sites.

import { trace } from "@opentelemetry/api";
import { ts } from "../logTime";

export interface LogFields {
  /** Agent session id (Claude/Pi session), when known. */
  sessionId?: string;
  /** Routine/job name. */
  job?: string;
  /** Hook thread id. */
  threadId?: string;
  [key: string]: unknown;
}

type Level = "info" | "warn" | "error";

/** Active-span trace id, or undefined when there's no active span / telemetry. */
function activeTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const sc = span?.spanContext();
  return sc && sc.traceId !== "0".repeat(32) ? sc.traceId : undefined;
}

function emit(level: Level, msg: string, fields?: LogFields): void {
  const merged: Record<string, unknown> = {};
  const traceId = activeTraceId();
  if (traceId) merged.trace_id = traceId;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      // Normalize the two first-class correlation keys to snake_case.
      if (k === "sessionId") merged.session_id = v;
      else merged[k] = v;
    }
  }
  const suffix = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : "";
  const line = `[${ts()}] ${msg}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Structured logger. Same surface as console, plus a fields bag. */
export const log = {
  info: (msg: string, fields?: LogFields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => emit("error", msg, fields),
};
