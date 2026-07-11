import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ClaudeRuntime } from "../runtime/claude";
import type { RuntimeResult } from "../runtime/types";
import {
  flushTelemetryForTest,
  getMetricsText,
  getTracer,
  initTelemetry,
  isTelemetryEnabled,
  parseTraceparent,
  recordRunMetrics,
  resolveOtelConfig,
  resetTelemetryForTest,
  startRunSpan,
} from "../telemetry";

// One logical Claude conversation on the wire: an assistant turn (with model +
// usage + stop_reason), a tool_use turn, its tool_result, a final turn, and the
// terminal result (usage + total_cost_usd + modelUsage).
const CLAUDE_WIRE =
  [
    `{"type":"system","subtype":"init","session_id":"s1"}`,
    `{"type":"assistant","message":{"id":"m1","model":"claude-opus-4","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":5},"stop_reason":"tool_use"}}`,
    `{"type":"assistant","message":{"id":"m2","model":"claude-opus-4","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"ok"}],"is_error":false}]}}`,
    `{"type":"assistant","message":{"id":"m3","model":"claude-opus-4","content":[{"type":"text","text":"done"}]}}`,
    `{"type":"result","result":"done","session_id":"s1","usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":5},"total_cost_usd":0.02,"modelUsage":{"claude-opus-4":{}}}`,
  ].join("\n") + "\n";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

const attr = (s: ReadableSpan, k: string): unknown => s.attributes[k];

// ---------------------------------------------------------------------------
// Config resolution — the no-op gate.
// ---------------------------------------------------------------------------
describe("resolveOtelConfig: off unless explicitly configured", () => {
  test("empty settings + empty env ⇒ disabled", () => {
    const cfg = resolveOtelConfig(undefined, {});
    expect(cfg.enabled).toBe(false);
    expect(cfg.prometheus).toBe(false);
  });

  test("an OTLP endpoint enables it", () => {
    const cfg = resolveOtelConfig(undefined, { ERRANDD_OTEL_ENDPOINT: "http://otel:4318" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.tracesEndpoint).toBe("http://otel:4318");
    expect(cfg.prometheus).toBe(true); // default-on with telemetry
  });

  test("explicit enable flag turns it on with no endpoint", () => {
    const cfg = resolveOtelConfig({ enabled: true }, {});
    expect(cfg.enabled).toBe(true);
  });

  test("ERRANDD_OTEL_ENABLED=0 is a hard kill switch", () => {
    const cfg = resolveOtelConfig({ enabled: true }, {
      ERRANDD_OTEL_ENABLED: "0",
      ERRANDD_OTEL_ENDPOINT: "http://otel:4318",
    });
    expect(cfg.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strict no-op when unconfigured — no tracer, no spans, no metrics.
// ---------------------------------------------------------------------------
describe("telemetry is a strict no-op when uninitialized", () => {
  test("getTracer is null and startRunSpan returns an inert handle", async () => {
    expect(isTelemetryEnabled()).toBe(false);
    expect(getTracer()).toBeNull();
    expect(await getMetricsText()).toBeNull();

    // Driving the no-op handle must not throw and must produce no traceparent.
    const handle = startRunSpan({ name: "x", system: "claude", requestModel: "opus" });
    handle.recordAssistantTurn({ model: "m", usage: { inputTokens: 1 } });
    handle.startTool("t1", "Bash", {});
    handle.endTool("t1", false);
    handle.end({ exitCode: 0 });
    expect(handle.traceparent()).toBeUndefined();
  });

  test("initTelemetry with disabled config stays a no-op", () => {
    initTelemetry(resolveOtelConfig(undefined, {}));
    expect(isTelemetryEnabled()).toBe(false);
    expect(getTracer()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enabled: span tree + gen_ai attributes, fed from the normalized stream.
// ---------------------------------------------------------------------------
describe("enabled: span tree + gen_ai attributes", () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    initTelemetry(
      { enabled: true, serviceName: "errandd", serviceVersion: "test", prometheus: true },
      { spanExporter: exporter },
    );
  });

  afterAll(async () => {
    await resetTelemetryForTest();
  });

  test("a run drives one root span + a span per turn + per tool call", async () => {
    exporter.reset();
    expect(isTelemetryEnabled()).toBe(true);

    // Mirror the runner: run the normalized stream through a run span.
    const rt = new ClaudeRuntime();
    const runSpan = startRunSpan({ name: "unit", system: rt.id, requestModel: "opus" });
    let result: RuntimeResult | undefined;
    await rt.parseStream(streamOf(CLAUDE_WIRE), {
      onAssistant: (blocks, _id, meta) => {
        runSpan.recordAssistantTurn(meta ?? {});
        for (const b of blocks) {
          if (b.type === "tool_use") runSpan.startTool(b.id, b.name, b.input);
        }
      },
      onToolResult: (id, _content, isError) => runSpan.endTool(id, isError),
      onResult: (ev) => {
        result = ev;
      },
    });
    runSpan.end({
      exitCode: 0,
      ...(result?.model ? { model: result.model } : {}),
      ...(result?.usage ? { usage: result.usage } : {}),
      ...(typeof result?.totalCostUsd === "number" ? { totalCostUsd: result.totalCostUsd } : {}),
      ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
    });

    await flushTelemetryForTest();
    const spans = exporter.getFinishedSpans();
    const byName = (n: string) => spans.filter((s) => s.name === n);

    // Root run span, 3 assistant turns, 1 tool span.
    expect(byName("agent.run").length).toBe(1);
    expect(byName("gen_ai.assistant").length).toBe(3);
    expect(byName("gen_ai.tool.Bash").length).toBe(1);

    // --- Root span gen_ai attributes ---
    const run = byName("agent.run")[0];
    expect(attr(run, "gen_ai.system")).toBe("claude");
    expect(attr(run, "gen_ai.request.model")).toBe("opus");
    expect(attr(run, "gen_ai.response.model")).toBe("claude-opus-4");
    expect(attr(run, "gen_ai.usage.input_tokens")).toBe(10);
    expect(attr(run, "gen_ai.usage.output_tokens")).toBe(3);
    expect(attr(run, "gen_ai.usage.cost")).toBe(0.02); // threaded through for 6/6
    expect(attr(run, "gen_ai.conversation.id")).toBe("s1");
    expect(attr(run, "errandd.exit_code")).toBe(0);

    // --- Assistant turn attributes (the tool_use turn carried stop_reason) ---
    const firstTurn = byName("gen_ai.assistant")[0];
    expect(attr(firstTurn, "gen_ai.response.model")).toBe("claude-opus-4");
    expect(attr(firstTurn, "gen_ai.response.finish_reasons")).toBe("tool_use");
    expect(attr(firstTurn, "gen_ai.usage.input_tokens")).toBe(10);

    // --- Tool span attributes ---
    const tool = byName("gen_ai.tool.Bash")[0];
    expect(attr(tool, "gen_ai.tool.name")).toBe("Bash");
    expect(attr(tool, "gen_ai.tool.call.id")).toBe("t1");

    // Tool span is a child of the run span (same trace).
    expect(tool.spanContext().traceId).toBe(run.spanContext().traceId);
    expect(tool.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
  });

  test("run metrics surface on the Prometheus endpoint", async () => {
    recordRunMetrics({
      durationSeconds: 1.5,
      outcome: "ok",
      usage: { inputTokens: 10, outputTokens: 3 },
      costUsd: 0.02,
      attrs: { system: "claude", job: "unit", model: "opus" },
    });
    const text = await getMetricsText();
    expect(text).not.toBeNull();
    expect(text).toContain("errandd_agent_run_duration");
    expect(text).toContain("errandd_llm_tokens_total");
    expect(text).toContain("errandd_hook_queue_depth");
  });

  test("the run span exposes a valid W3C traceparent for subprocess propagation", () => {
    const handle = startRunSpan({ name: "tp", system: "claude" });
    const tp = handle.traceparent();
    handle.end({ exitCode: 0 });
    expect(tp).toBeDefined();
    const parsed = parseTraceparent(tp);
    expect(parsed).toBeDefined();
    expect(parsed?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Span-link parsing (webhook → run propagation).
// ---------------------------------------------------------------------------
describe("parseTraceparent", () => {
  test("round-trips a valid traceparent and rejects malformed/all-zero", () => {
    const valid = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const sc = parseTraceparent(valid);
    expect(sc?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(sc?.spanId).toBe("b7ad6b7169203331");
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent("garbage")).toBeUndefined();
    expect(parseTraceparent("00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-00")).toBeUndefined();
  });
});
