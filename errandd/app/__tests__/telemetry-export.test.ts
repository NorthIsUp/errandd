import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../runtime/codex";
import { ClaudeRuntime } from "../runtime/claude";
import { PiRuntime } from "../runtime/pi";
import { codexTelemetryArgs, telemetryChildEnv } from "../telemetry/subprocess";
import { resolveOtelConfig } from "../telemetry/config";

test("standard OTel service name and per-signal headers are resolved without leaking across signals", () => {
  const cfg = resolveOtelConfig(undefined, {
    OTEL_SERVICE_NAME: "errandd-production",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=base%20token",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "dd-otlp-source=llmobs",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "authorization=metric%20token",
  });
  expect(cfg.serviceName).toBe("errandd-production");
  expect(cfg.headers).toEqual({ authorization: "base token" });
  expect(cfg.tracesHeaders).toEqual({ "dd-otlp-source": "llmobs" });
  expect(cfg.metricsHeaders).toEqual({ authorization: "metric token" });
});

test("disabled telemetry leaves child arguments and environment unchanged", () => {
  const env = { ERRANDD_OTEL_ENABLED: "0", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
  const args = ["codex", "exec", "--", "prompt"];
  expect(telemetryChildEnv(env, "claude")).toBe(env);
  expect(codexTelemetryArgs(args, env)).toBe(args);
});

test("each runtime passes native telemetry settings and trace context into its real subprocess", async () => {
  const directory = await mkdtemp(join(tmpdir(), "errandd-otel-child-"));
  try {
    const fixture = join(directory, "cli");
    await writeFile(fixture, `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),env:process.env}));\n`);
    await chmod(fixture, 0o755);
    const env = {
      PATH: process.env.PATH ?? "", ERRANDD_OTEL_ENABLED: "1",
      OTEL_SERVICE_NAME: "errandd", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:4318/v1/metrics",
      TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "dd-otlp-source=llmobs",
    };
    for (const runtime of [new ClaudeRuntime(), new CodexRuntime(), new PiRuntime()]) {
      const proc = runtime.spawn([fixture, "exec", "resume", "session", "--", "prompt"], env);
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, stderr).toBe(0);
      const child = JSON.parse(stdout) as { args: string[]; env: Record<string, string> };
      expect(child.env.TRACEPARENT).toBe(env.TRACEPARENT);
      expect(child.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe("http://collector:4318/v1/traces");
      expect(child.env.OTEL_TRACES_EXPORTER).toBe("otlp");
      expect(child.env.OTEL_METRICS_EXPORTER).toBe("otlp");
      if (runtime.id === "claude") {
        expect(child.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
        expect(child.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe("1");
        expect(child.env.OTEL_LOGS_EXPORTER).toBe("otlp");
      }
      if (runtime.id === "codex") {
        const setting = child.args.find(arg => arg.startsWith("otel.trace_exporter="));
        expect(setting).toContain('endpoint="http://collector:4318/v1/traces"');
        expect(setting).toContain('"dd-otlp-source"="llmobs"');
        expect(child.args.slice(-5)).toEqual(["exec", "resume", "session", "--", "prompt"]);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OTLP HTTP export delivers Datadog-compatible GenAI spans and signal-specific headers", async () => {
  const requests: { path: string; header: string | null; body: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, header: request.headers.get("dd-otlp-source"), body: await request.text() });
      return new Response(new Uint8Array(), { headers: { "content-type": "application/x-protobuf" } });
    },
  });
  const app = join(import.meta.dir, "..");
  try {
    const script = `
      import { initTelemetry, shutdownTelemetry } from ${JSON.stringify(join(app, "telemetry/otel.ts"))};
      import { resolveOtelConfig } from ${JSON.stringify(join(app, "telemetry/config.ts"))};
      import { startRunSpan } from ${JSON.stringify(join(app, "telemetry/spans.ts"))};
      initTelemetry(resolveOtelConfig(undefined, {
        OTEL_SERVICE_NAME: "errandd-export-test", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:${server.port}",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "dd-otlp-source=llmobs", ERRANDD_OTEL_PROMETHEUS: "0"
      }));
      for (const system of ["claude", "codex"]) {
        const span = startRunSpan({ name: "review", system, requestModel: system === "claude" ? "sonnet" : "gpt-test-sol" });
        span.recordAssistantTurn({ stopReason: "stop", usage: { inputTokens: 12, outputTokens: 3 } });
        span.startTool("tool", "shell", {}); span.endTool("tool", false);
        span.end({ exitCode: 0, sessionId: "session", usage: { inputTokens: 12, outputTokens: 3 }, totalCostUsd: 0.01 });
      }
      await shutdownTelemetry();
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OTEL_RESOURCE_ATTRIBUTES: "dd_llmobs_enabled=true" },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/v1/traces");
    expect(requests[0].header).toBe("llmobs");
    for (const value of ["errandd-export-test", "dd_llmobs_enabled", "invoke_agent", "gen_ai.provider.name", "anthropic", "openai", "gen_ai.usage.cost.currency", "USD", "gen_ai.conversation.id"]) {
      expect(requests[0].body).toContain(value);
    }
  } finally {
    await server.stop(true);
  }
}, 15_000);
