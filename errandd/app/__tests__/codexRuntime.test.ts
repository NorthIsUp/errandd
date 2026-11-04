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
  expect(args).toContain('sandbox_mode="danger-full-access"');
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
  ).toContain('sandbox_mode="danger-full-access"');
  expect(runtime.capabilities.reportsContextTokens).toBe(false);
});

test("Codex trusts all actions for every security level, including resume and fork", () => {
  for (const level of ["locked", "strict", "moderate", "unrestricted"] as const) {
    for (const resumeSessionId of [undefined, "saved-session"]) {
      const args = runtime.buildRunArgs(spec({ resumeSessionId, security: { level, allowedTools: ["Read"], disallowedTools: ["Bash"] } }));
      expect(args).toContain('approval_policy="never"');
      expect(args).toContain('sandbox_mode="danger-full-access"');
      expect(args).not.toContain("features.shell_tool=false");
      expect(args).not.toContain('web_search="disabled"');
      expect(args).not.toContain("--disallowedTools");
      expect(args).not.toContain("--allowedTools");
    }
  }
  const fork = runtime.buildForkArgs({ prompt: "fork", model: "gpt-fixture-sol", systemPrompt: "instructions", securityArgs: [] });
  expect(fork).toContain('approval_policy="never"');
  expect(fork).toContain('sandbox_mode="danger-full-access"');
  expect(fork).not.toContain("features.shell_tool=false");
});

test("Codex argument rewrites preserve flag-like prompt, model and instruction values", () => {
  for (const model of ["resume", "--json"]) {
    const args = runtime.buildRunArgs(spec({ model, prompt: "resume --json", resumeSessionId: "saved", appendSystemPrompt: "resume" }));
    const fresh = runtime.stripResume(args);
    expect(fresh.slice(-2)).toEqual(["--", "resume --json"]);
    expect(fresh[fresh.indexOf("--model") + 1]).toBe(model);
    expect(fresh).not.toContain("saved");
    expect(runtime.withOutputMode(runtime.withOutputMode(args, "text"), "stream")).toEqual(args);
  }
  expect(runtime.resumeArgs("  ")).toEqual([]);
  expect(() => runtime.buildCompactArgs()).toThrow("does not expose in-session compaction");
  expect(runtime.isStaleSession("", "No rollout found")).toBe(true);
  expect(runtime.isStaleSession("", "thread abc does not exist")).toBe(true);
  expect(runtime.isStaleSession("", "authentication failed")).toBe(false);
});

test("Codex normalizes MCP, file, web and failed tools while ignoring malformed records", async () => {
  const blocks: RuntimeBlock[] = [];
  const outputs: { id: string; content: unknown; failed: boolean }[] = [];
  let hints = 0;
  const events = [
    { type: "item.completed", item: { id: "mcp", type: "mcp_tool_call", tool: "lookup", arguments: { key: "value" }, result: { answer: 42 } } },
    { type: "item.completed", item: { id: "file", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "failed" } },
    { type: "item.completed", item: { id: "web", type: "web_search", query: "docs", error: "offline" } },
    { type: "item.completed", item: { id: "shell", type: "command_execution", command: "false", exit_code: 1, aggregated_output: "failed" } },
    { type: "item.completed", item: { id: "ignored", type: "unknown" } },
    { type: "turn.completed" },
  ];
  const results: RuntimeResult[] = [];
  const wire = `not-json\nnull\n[]\n${events.map(event => JSON.stringify(event)).join("\n")}`;
  await runtime.parseStream(new Blob([wire]).stream(), {
    onAssistant: value => { blocks.push(...value); },
    onToolResult: (id, content, failed) => { outputs.push({ id, content, failed }); },
    onToolUseHint: () => { hints++; },
    onResult: result => { results.push(result); },
  });
  expect(blocks.map(block => block.type === "tool_use" ? block.name : "text")).toEqual(["lookup", "file_change", "web_search", "command_execution"]);
  expect(blocks[0]).toMatchObject({ type: "tool_use", input: { key: "value" } });
  expect(outputs).toEqual([
    { id: "mcp", content: { answer: 42 }, failed: false },
    { id: "file", content: [{ path: "a.ts", kind: "update" }], failed: true },
    { id: "web", content: "offline", failed: true },
    { id: "shell", content: "failed", failed: true },
  ]);
  expect(hints).toBe(4);
  expect(results).toEqual([{ text: "", sessionId: undefined, contextTokens: 0, usage: {} }]);
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
