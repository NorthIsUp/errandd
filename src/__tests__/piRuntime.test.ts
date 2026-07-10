import { test, expect } from "bun:test";
import { PiRuntime } from "../runtime/pi";
import { parsePiRuntimeStream } from "../runtime/pi/stream";
import type { RuntimeBlock } from "../runtime/types";

// Event lines below are taken from Pi's documented JSON-mode schema
// (packages/coding-agent/docs/json.md): NDJSON, session header carries the id
// on `id`, assistant text arrives on `message_end`, tool calls are their own
// `tool_execution_start` / `tool_execution_end` lifecycle events, and the final
// transcript arrives on `agent_end.messages`.

/** Byte stream split mid-way to prove the line buffer stitches across reads. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const mid = Math.floor(bytes.length / 2);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.subarray(0, mid));
      c.enqueue(bytes.subarray(mid));
      c.close();
    },
  });
}

interface Captured {
  sessions: string[];
  assistant: { blocks: RuntimeBlock[]; id: string }[];
  toolResults: { id: string; content: unknown; isError: boolean }[];
  results: { text: string; contextTokens: number }[];
  hints: number;
}

async function run(lines: string[]): Promise<Captured> {
  const cap: Captured = { sessions: [], assistant: [], toolResults: [], results: [], hints: 0 };
  await parsePiRuntimeStream(streamOf(lines.join("\n")), {
    onSession: (id) => void cap.sessions.push(id),
    onAssistant: (blocks, id) => void cap.assistant.push({ blocks, id }),
    onToolResult: (id, content, isError) => void cap.toolResults.push({ id, content, isError }),
    onResult: (ev) => void cap.results.push({ text: ev.text, contextTokens: ev.contextTokens }),
    onToolUseHint: () => void cap.hints++,
  });
  return cap;
}

test("session id comes from the `id` field of the session header", async () => {
  const cap = await run([`{"type":"session","version":3,"id":"abc-123","cwd":"/tmp"}`]);
  expect(cap.sessions).toEqual(["abc-123"]);
});

test("assistant text is taken from message_end, and message_update is ignored", async () => {
  const cap = await run([
    `{"type":"message_start","message":{"role":"assistant","content":[]}}`,
    `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"par"}]},"assistantMessageEvent":{}}`,
    `{"type":"message_end","message":{"role":"assistant","responseId":"m1","content":[{"type":"thinking","thinking":"skip"},{"type":"text","text":"partial then whole"}]}}`,
  ]);
  // Exactly one emission — deltas must not double-emit the turn.
  expect(cap.assistant.length).toBe(1);
  expect(cap.assistant[0].id).toBe("m1");
  expect(cap.assistant[0].blocks).toEqual([{ type: "text", text: "partial then whole" }]);
});

test("tool_execution_start is a UI hint only — the tool_use block rides the assistant message", async () => {
  // Real pi (0.80.6) emits the toolCall block on the assistant message_end AND
  // then a tool_execution_start. Synthesizing a block here would double-emit.
  const cap = await run([
    `{"type":"message_end","message":{"role":"assistant","responseId":"m2","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"cmd":"ls"}}]}}`,
    `{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"cmd":"ls"}}`,
  ]);
  expect(cap.hints).toBe(1);
  expect(cap.assistant.length).toBe(1); // exactly one, not two
  expect(cap.assistant[0].blocks).toEqual([
    { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
  ]);
});

test("message_end for user and toolResult roles is never forwarded", async () => {
  const cap = await run([
    `{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"prompt"}]}}`,
    `{"type":"message_end","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"out"}]}}`,
  ]);
  expect(cap.assistant).toEqual([]);
});

test("assistant usage is latched and reported as contextTokens at agent_end", async () => {
  const cap = await run([
    `{"type":"message_end","message":{"role":"assistant","responseId":"m1","content":[{"type":"text","text":"hi"}],"usage":{"input":100,"cacheRead":20,"cacheWrite":5}}}`,
    `{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"hi"}]}]}`,
  ]);
  expect(cap.results[0].contextTokens).toBe(125);
});

test("tool_execution_end passes the RAW result through with its error flag", async () => {
  const cap = await run([
    `{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"content":[{"type":"text","text":"hi"}]},"isError":true}`,
  ]);
  // `.content` is unwrapped so the payload matches Claude's raw tool_result shape.
  expect(cap.toolResults).toEqual([{ id: "t1", content: [{ type: "text", text: "hi" }], isError: true }]);
});

test("agent_end yields the last assistant message's text, with zero context tokens", async () => {
  const cap = await run([
    `{"type":"agent_end","messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"text","text":"first"}]},{"role":"assistant","content":[{"type":"text","text":"final answer"}]}]}`,
  ]);
  expect(cap.results).toEqual([{ text: "final answer", contextTokens: 0 }]);
});

test("a trailing line with no newline is still dispatched", async () => {
  const cap = await run([`{"type":"session","id":"s1"}`, `{"type":"agent_end","messages":[]}`]);
  expect(cap.sessions).toEqual(["s1"]);
  expect(cap.results.length).toBe(1);
});

test("malformed lines and unknown events are skipped, not fatal", async () => {
  const cap = await run([
    `not json`,
    `{"type":"queue_update","steering":[]}`,
    `{"type":"compaction_start","reason":"threshold"}`,
    `{"type":"session","id":"s2"}`,
  ]);
  expect(cap.sessions).toEqual(["s2"]);
});

// --- argv -------------------------------------------------------------------

test("buildRunArgs: stream mode uses `--mode json`, text mode uses `-p`", () => {
  const rt = new PiRuntime();
  const stream = rt.buildRunArgs({ prompt: "hi", outputMode: "stream", model: "", security: {} as never, jobsRepoArgs: [] });
  expect(stream.join(" ")).toContain("--mode json");
  // -p is required in every mode: without it a tool call blocks on approval.
  expect(stream).toContain("-p");
  expect(stream.at(-1)).toBe("hi"); // prompt is positional and last

  const text = rt.buildRunArgs({ prompt: "hi", outputMode: "text", model: "", security: {} as never, jobsRepoArgs: [] });
  expect(text).toContain("-p");
  expect(text).not.toContain("--mode");
});

test("buildRunArgs: never emits a --format flag (Pi has no such flag)", () => {
  const rt = new PiRuntime();
  const args = rt.buildRunArgs({ prompt: "x", outputMode: "stream", model: "m", security: {} as never, jobsRepoArgs: [] });
  expect(args).not.toContain("--format");
});

test("buildRunArgs: effort maps to --thinking, and an invalid level is dropped", () => {
  const rt = new PiRuntime();
  const ok = rt.buildRunArgs({ prompt: "x", outputMode: "text", model: "", effort: "high", security: {} as never, jobsRepoArgs: [] });
  expect(ok.join(" ")).toContain("--thinking high");

  const bad = rt.buildRunArgs({ prompt: "x", outputMode: "text", model: "", effort: "bogus", security: {} as never, jobsRepoArgs: [] });
  expect(bad).not.toContain("--thinking");
});

test("buildRunArgs: resume emits --session <id> (Pi supports resume)", () => {
  const rt = new PiRuntime();
  expect(rt.capabilities.supportsResume).toBe(true);
  const args = rt.buildRunArgs({ prompt: "x", outputMode: "stream", model: "", resumeSessionId: "sess-9", security: {} as never, jobsRepoArgs: [] });
  expect(args.join(" ")).toContain("--session sess-9");
});

test("buildRunArgs: Claude-shaped jobsRepoArgs are not forwarded", () => {
  const rt = new PiRuntime();
  const args = rt.buildRunArgs({ prompt: "x", outputMode: "text", model: "", security: {} as never, jobsRepoArgs: ["--plugin-dir", "/p"] });
  expect(args).not.toContain("--plugin-dir");
});

test("withOutputMode swaps -p ↔ --mode json without disturbing the trailing prompt", () => {
  const rt = new PiRuntime();
  const text = rt.buildRunArgs({ prompt: "hi", outputMode: "text", model: "m", security: {} as never, jobsRepoArgs: [] });
  const streamed = rt.withOutputMode(text, "stream");
  expect(streamed.join(" ")).toContain("--mode json");
  expect(streamed).toContain("-p");
  expect(streamed.filter((a) => a === "-p").length).toBe(1); // no accumulation
  expect(streamed.at(-1)).toBe("hi");
  expect(streamed[0]).toBe(rt.executablePath);

  const backToText = rt.withOutputMode(streamed, "text");
  expect(backToText).toContain("-p");
  expect(backToText).not.toContain("--mode");
  expect(backToText.at(-1)).toBe("hi");
});

test("stripResume removes --session/--fork with their values and bare -c", () => {
  const rt = new PiRuntime();
  expect(rt.stripResume(["pi", "--session", "s1", "-p", "hi"])).toEqual(["pi", "-p", "hi"]);
  expect(rt.stripResume(["pi", "--continue", "-p", "hi"])).toEqual(["pi", "-p", "hi"]);
  expect(rt.stripResume(["pi", "--fork", "abc", "hi"])).toEqual(["pi", "hi"]);
});

test("resumeArgs round-trips through buildRunArgs' own flag name", () => {
  const rt = new PiRuntime();
  expect(rt.resumeArgs("s1")).toEqual(["--session", "s1"]);
  expect(rt.resumeArgs("  ")).toEqual([]);
});

test("capabilities reflect Pi's documented reality", () => {
  const caps = new PiRuntime().capabilities;
  expect(caps.supportsResume).toBe(true); // --session / -c
  expect(caps.reportsContextTokens).toBe(true); // usage.{input,cacheRead,cacheWrite}
  expect(caps.supportsMcpCli).toBe(false); // Pi documents "No MCP"
});

test("isStaleSession only fires on session-specific errors", () => {
  const rt = new PiRuntime();
  expect(rt.isStaleSession("", "Error: session not found: abc")).toBe(true);
  expect(rt.isStaleSession("", "ENOENT: no such file or directory")).toBe(false);
});
