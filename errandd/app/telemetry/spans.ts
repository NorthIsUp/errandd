// LLM span tree — root run span + per-turn + per-tool child spans.
//
// The span tree (req 3):
//   agent run (root, SpanKind.CLIENT)
//     ├─ gen_ai.assistant  (one per assistant turn)
//     └─ gen_ai.tool.<name> (one per tool_use → tool_result pair)
//
// All attributes come from the NORMALIZED runtime stream (RuntimeAssistantMeta /
// RuntimeResult), never from re-parsed NDJSON. Every helper is a strict no-op
// when telemetry is off: `startRunSpan` returns a shared no-op handle, so the
// runner calls the same methods unconditionally with zero overhead when
// disabled.
//
// Propagation (req 5): a run span may be LINKED (not parented) to the webhook
// span that triggered it, via `linkedTraceparent`. The subprocess gets the run
// span's own `traceparent()` in its env, best-effort.

import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import type { RuntimeAssistantMeta, RuntimeUsage } from "../runtime/types";
import { getTracer } from "./otel";

/** A handle to an in-flight agent-run span. Methods are no-ops when telemetry
 *  is off (see NOOP_RUN_SPAN). */
export interface RunSpanHandle {
  /** Record one assistant turn as a child span (model, usage, stop reason). */
  recordAssistantTurn(meta: RuntimeAssistantMeta): void;
  /** Open a child span for a tool call (tool_use). Paired with `endTool`. */
  startTool(toolUseId: string, name: string, input: Record<string, unknown>): void;
  /** Close a tool call's child span when its tool_result arrives. */
  endTool(toolUseId: string, isError: boolean): void;
  /** Finalize the run span with the terminal result. */
  end(result: RunSpanResult): void;
  /** W3C `traceparent` for THIS run span, to hand to the child subprocess
   *  (best-effort propagation). Undefined when telemetry is off. */
  traceparent(): string | undefined;
}

export interface RunSpanResult {
  exitCode: number;
  model?: string;
  usage?: RuntimeUsage;
  totalCostUsd?: number;
  sessionId?: string;
}

export interface StartRunSpanOpts {
  /** Routine/job name (chat/heartbeat/pr-review/…). */
  name: string;
  /** Runtime id → gen_ai.system (claude/pi). */
  system: string;
  /** The requested model → gen_ai.request.model. */
  requestModel?: string;
  /** W3C traceparent of the triggering webhook span to LINK to (not parent). */
  linkedTraceparent?: string;
}

const NOOP_RUN_SPAN: RunSpanHandle = {
  recordAssistantTurn: () => {},
  startTool: () => {},
  endTool: () => {},
  end: () => {},
  traceparent: () => undefined,
};

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parse a W3C `traceparent` string into a SpanContext, or undefined if
 *  malformed / all-zero (invalid) — used to LINK a run span to its webhook. */
export function parseTraceparent(tp: string | undefined): SpanContext | undefined {
  if (!tp) return undefined;
  const m = TRACEPARENT_RE.exec(tp.trim());
  if (!m) return undefined;
  const [, traceId, spanId, flags] = m;
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return undefined;
  return {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
  };
}

/** Serialize a SpanContext to a W3C `traceparent` string. */
function toTraceparent(sc: SpanContext): string {
  const flags = (sc.traceFlags & TraceFlags.SAMPLED ? 1 : 0).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

function applyUsageAttrs(span: Span, usage: RuntimeUsage | undefined): void {
  if (!usage) return;
  if (typeof usage.inputTokens === "number") {
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  }
  if (typeof usage.outputTokens === "number") {
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  }
  if (typeof usage.totalTokens === "number") {
    span.setAttribute("gen_ai.usage.total_tokens", usage.totalTokens);
  }
  if (typeof usage.cacheReadTokens === "number") {
    span.setAttribute("gen_ai.usage.cache_read_tokens", usage.cacheReadTokens);
  }
}

/**
 * Start a root span for an agent run. Returns a no-op handle when telemetry is
 * off. The returned handle owns the child-span bookkeeping (per-turn spans + a
 * map of open tool spans keyed by tool_use id).
 */
export function startRunSpan(opts: StartRunSpanOpts): RunSpanHandle {
  const tracer = getTracer();
  if (!tracer) return NOOP_RUN_SPAN;

  const linked = parseTraceparent(opts.linkedTraceparent);
  const runSpan = tracer.startSpan("agent.run", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.operation.name": "agent",
      "gen_ai.system": opts.system,
      ...(opts.requestModel ? { "gen_ai.request.model": opts.requestModel } : {}),
      "errandd.job": opts.name,
    },
    ...(linked ? { links: [{ context: linked }] } : {}),
  });

  // Parent context for children — explicit, so we never depend on ambient
  // AsyncLocalStorage propagation across the runner's awaits.
  const parentCtx = trace.setSpan(context.active(), runSpan);
  const toolSpans = new Map<string, Span>();

  return {
    recordAssistantTurn(meta: RuntimeAssistantMeta): void {
      const span = tracer.startSpan(
        "gen_ai.assistant",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.system": opts.system,
            ...(meta.model ? { "gen_ai.response.model": meta.model } : {}),
            ...(meta.stopReason ? { "gen_ai.response.finish_reasons": meta.stopReason } : {}),
          },
        },
        parentCtx,
      );
      applyUsageAttrs(span, meta.usage);
      // A turn arrives already-complete (message_end), so the span is a
      // point-in-time record of the turn's attributes.
      span.end();
    },

    startTool(toolUseId: string, name: string, _input: Record<string, unknown>): void {
      if (!toolUseId) return;
      const span = tracer.startSpan(
        `gen_ai.tool.${name || "unknown"}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.system": opts.system,
            "gen_ai.tool.name": name,
            "gen_ai.tool.call.id": toolUseId,
          },
        },
        parentCtx,
      );
      toolSpans.set(toolUseId, span);
    },

    endTool(toolUseId: string, isError: boolean): void {
      const span = toolSpans.get(toolUseId);
      if (!span) return;
      toolSpans.delete(toolUseId);
      if (isError) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("error", true);
      }
      span.end();
    },

    end(result: RunSpanResult): void {
      // Close any tool spans still open (tool never returned before the run
      // ended) so they don't leak.
      for (const [, span] of toolSpans) span.end();
      toolSpans.clear();

      if (result.model) runSpan.setAttribute("gen_ai.response.model", result.model);
      if (result.sessionId) runSpan.setAttribute("gen_ai.conversation.id", result.sessionId);
      applyUsageAttrs(runSpan, result.usage);
      if (typeof result.totalCostUsd === "number") {
        // Threaded through for the pricing work (overhaul 6/6); not computed here.
        runSpan.setAttribute("gen_ai.usage.cost", result.totalCostUsd);
      }
      runSpan.setAttribute("errandd.exit_code", result.exitCode);
      if (result.exitCode !== 0) {
        runSpan.setStatus({ code: SpanStatusCode.ERROR, message: `exit ${result.exitCode}` });
      }
      runSpan.end();
    },

    traceparent(): string | undefined {
      const sc = runSpan.spanContext();
      return sc.traceId ? toTraceparent(sc) : undefined;
    },
  };
}

/**
 * Start a short-lived span for a webhook intake, returning its `traceparent`
 * string (to stamp on the queued job) — or undefined when telemetry is off. The
 * span ends immediately; the run span that eventually processes the delivery
 * LINKS back to it (webhook→queue→job is async + best-effort, not a hard
 * parent-child edge). No-op-safe.
 */
export function recordWebhookSpan(opts: {
  source: string;
  event: string;
  job: string;
  deliveryId: string;
}): string | undefined {
  const tracer = getTracer();
  if (!tracer) return undefined;
  const span = tracer.startSpan("webhook.intake", {
    kind: SpanKind.SERVER,
    attributes: {
      "errandd.hook.source": opts.source,
      "errandd.hook.event": opts.event,
      "errandd.job": opts.job,
      "errandd.delivery_id": opts.deliveryId,
    },
  });
  const tp = toTraceparent(span.spanContext());
  span.end();
  return tp;
}
