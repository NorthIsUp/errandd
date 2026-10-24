import { expect, test } from "bun:test";
import { CodexRuntime } from "../runtime/codex";
import { hasRuntime, resetRuntimeCache, resolveRuntime } from "../runtime/registry";
import type { RunSpec, RuntimeBlock, RuntimeResult } from "../runtime/types";

const runtime = new CodexRuntime();
const spec = (extra: Partial<RunSpec> = {}): RunSpec => ({
  prompt: "hello",
  outputMode: "stream",
  model: "",
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  jobsRepoArgs: [],
  ...extra,
});

test("Codex is a built-in and registry lookup is case-insensitive", () => {
  expect(hasRuntime("codex")).toBe(true);
  resetRuntimeCache();
  expect(resolveRuntime(() => " CODEX ").id).toBe("codex");
  resetRuntimeCache();
});

test("Codex argv maps sandbox, instructions, reasoning, model and resume", () => {
  const args = runtime.buildRunArgs(
    spec({
      prompt: "--json",
      resumeSessionId: "session-id",
      model: "custom-model",
      effort: "high",
      appendSystemPrompt: 'Use "quotes"\nand lines',
    }),
  );
  expect(args.slice(0, 2)).toEqual([runtime.executablePath, "exec"]);
  expect(args).toContain('sandbox_mode="workspace-write"');
  expect(args).toContain('model_reasoning_effort="high"');
  expect(args).toContain(`developer_instructions=${JSON.stringify('Use "quotes"\nand lines')}`);
  expect(args.slice(-4)).toEqual(["resume", "session-id", "--", "--json"]);
  expect(runtime.stripResume(args)).not.toContain("resume");
  expect(runtime.stripResume(args).at(-1)).toBe("--json");
  expect(runtime.withOutputMode(args, "text").at(-1)).toBe("--json");
  expect(runtime.withOutputMode(runtime.withOutputMode(args, "text"), "stream")).toEqual(args);
});

test("Codex uses its own auth and never forwards Claude flags", () => {
  const args = runtime.buildRunArgs(
    spec({ jobsRepoArgs: ["--plugin-dir", "/tmp/plugin"], settingsJson: "{}" }),
  );
  expect(args).not.toContain("--plugin-dir");
  expect(args).not.toContain("--settings");
  expect(runtime.buildChildEnv({ HOME: "/tmp/home" }, "", "secret")).toEqual({
    HOME: "/tmp/home",
    CODEX_API_KEY: "secret",
  });
  expect(
    runtime.buildRunArgs(
      spec({ security: { level: "locked", allowedTools: [], disallowedTools: [] } }),
    ),
  ).toContain('sandbox_mode="read-only"');
  expect(runtime.capabilities.reportsContextTokens).toBe(false);
});

test("Codex JSONL handles chunk boundaries, tools once, usage and trailing line", async () => {
  const wire = [
    { type: "thread.started", thread_id: "session-id" },
    {
      type: "item.started",
      item: { id: "t1", type: "command_execution", command: "echo hi", status: "in_progress" },
    },
    {
      type: "item.completed",
      item: {
        id: "t1",
        type: "command_execution",
        command: "echo hi",
        aggregated_output: "hi",
        exit_code: 0,
        status: "completed",
      },
    },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done 🐱" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(new Uint8Array([byte]));
      }
      controller.close();
    },
  });
  const blocks: RuntimeBlock[] = [];
  const results: RuntimeResult[] = [];
  const outputs: unknown[] = [];
  await runtime.parseStream(stream, {
    onAssistant: (value) => {
      blocks.push(...value);
    },
    onToolResult: (_id, content) => {
      outputs.push(content);
    },
    onResult: (value) => {
      results.push(value);
    },
  });
  expect(blocks).toEqual([
    { type: "tool_use", id: "t1", name: "command_execution", input: { command: "echo hi" } },
    { type: "text", text: "done 🐱" },
  ]);
  expect(outputs).toEqual(["hi"]);
  expect(results[0]).toEqual({
    text: "done 🐱",
    sessionId: "session-id",
    contextTokens: 0,
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 10 },
  });
});
