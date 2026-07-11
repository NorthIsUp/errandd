// Telemetry metric instruments + recording.
//
// Instruments are created once from the meter by otel.ts's initTelemetry. When
// telemetry is off, `initMetrics` is never called, the module-level instruments
// stay null, and every `record*` call is a cheap no-op — so metric recording is
// safe to sprinkle on hot paths unconditionally.

import type { Counter, Histogram, Meter, ObservableGauge } from "@opentelemetry/api";
import { ValueType } from "@opentelemetry/api";
import type { RuntimeUsage } from "../runtime/types";

interface Instruments {
  /** End-to-end agent-run latency, seconds. */
  runDuration: Histogram;
  /** LLM token usage, attributed by `gen_ai.token.type` (input/output). */
  tokens: Counter;
  /** CLI-reported run cost, USD (only recorded when the result carries it). */
  cost: Counter;
  /** Completed agent runs, attributed by `outcome` (ok/error). */
  runs: Counter;
  /** Pending hook-queue depth (observable). */
  queueDepth: ObservableGauge;
}

let instruments: Instruments | null = null;

// The observable queue-depth gauge reads its value from a provider registered
// by the daemon (start.ts) — decoupled so metrics.ts never imports the queue
// (avoids a DB-constructing side effect in tests). Absent ⇒ reports 0.
let queueDepthProvider: (() => number) | null = null;

/** Register the source of the hook-queue depth gauge (called from start.ts). */
export function registerQueueDepthProvider(fn: () => number): void {
  queueDepthProvider = fn;
}

/** Create the instrument set from the meter. Called once by initTelemetry. */
export function initMetrics(meter: Meter): void {
  const runDuration = meter.createHistogram("errandd.agent.run.duration", {
    description: "End-to-end agent-run latency",
    unit: "s",
    valueType: ValueType.DOUBLE,
  });
  const tokens = meter.createCounter("errandd.llm.tokens", {
    description: "LLM token usage by type",
    valueType: ValueType.INT,
  });
  const cost = meter.createCounter("errandd.llm.cost.usd", {
    description: "CLI-reported LLM run cost in USD",
    unit: "usd",
    valueType: ValueType.DOUBLE,
  });
  const runs = meter.createCounter("errandd.agent.runs", {
    description: "Completed agent runs by outcome",
    valueType: ValueType.INT,
  });
  const queueDepth = meter.createObservableGauge("errandd.hook_queue.depth", {
    description: "Ready-pending hook-queue messages",
    valueType: ValueType.INT,
  });
  queueDepth.addCallback((result) => {
    try {
      result.observe(queueDepthProvider ? queueDepthProvider() : 0);
    } catch {
      result.observe(0);
    }
  });

  instruments = { runDuration, tokens, cost, runs, queueDepth };
}

/** Drop the instrument set (telemetry shutdown / test reset). */
export function resetMetrics(): void {
  instruments = null;
}

/** Outcome of a finished agent run for the runs counter. */
export type RunOutcome = "ok" | "error";

/** Attributes shared across a run's metrics (model + who triggered it). */
export interface RunMetricAttrs {
  model?: string;
  /** Runtime id (claude/pi). */
  system?: string;
  /** Routine/job name. */
  job?: string;
}

/**
 * Record all metrics for one finished agent run, from the normalized result.
 * No-op when telemetry is off. Called from the runner's onResult hot path.
 */
export function recordRunMetrics(opts: {
  durationSeconds: number;
  outcome: RunOutcome;
  usage?: RuntimeUsage;
  costUsd?: number;
  attrs?: RunMetricAttrs;
}): void {
  if (!instruments) return;
  const base: Record<string, string> = {};
  if (opts.attrs?.model) base["gen_ai.response.model"] = opts.attrs.model;
  if (opts.attrs?.system) base["gen_ai.system"] = opts.attrs.system;
  if (opts.attrs?.job) base.job = opts.attrs.job;

  instruments.runDuration.record(opts.durationSeconds, base);
  instruments.runs.add(1, { ...base, outcome: opts.outcome });

  const u = opts.usage;
  if (u) {
    if (typeof u.inputTokens === "number") {
      instruments.tokens.add(u.inputTokens, { ...base, "gen_ai.token.type": "input" });
    }
    if (typeof u.outputTokens === "number") {
      instruments.tokens.add(u.outputTokens, { ...base, "gen_ai.token.type": "output" });
    }
  }
  if (typeof opts.costUsd === "number" && opts.costUsd > 0) {
    instruments.cost.add(opts.costUsd, base);
  }
}
