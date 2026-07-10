import { test, expect, describe } from "bun:test";
import { ClaudeRuntime } from "../runtime/claude";
import { PiRuntime } from "../runtime/pi";
import type { RunSpec, Runtime, RuntimeBlock } from "../runtime/types";
import type { SecurityConfig } from "../config";

// ---------------------------------------------------------------------------
// Runtime conformance matrix.
//
// The whole point of the Runtime seam is that callers (runner.ts, the queue,
// the UI) never learn which CLI is underneath. That only holds if every runtime
// normalizes to the SAME event stream and obeys the same argv contract.
//
// So: express ONE logical conversation in each runtime's NATIVE wire format,
// run it through that runtime's own parseStream, and assert the normalized
// output is identical. A schema drift in either adapter — exactly the bug that
// shipped in the first Pi implementation, where invented event names passed an
// invented fixture — shows up here as a diff against the other runtime.
//
// Things that legitimately differ (message ids, context tokens, plugin flags)
// are asserted through `capabilities`, never hard-coded per runtime.
//
// Real-binary end-to-end coverage lives in runtime-e2e.test.ts (opt-in).
// ---------------------------------------------------------------------------

const security: SecurityConfig = { level: "moderate", allowedTools: [], disallowedTools: [] };

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return { prompt: "say hi", outputMode: "stream", model: "", security, jobsRepoArgs: [], ...over };
}

// The one logical conversation, as each runtime ACTUALLY emits it on the wire:
//   assistant says "hello", calls bash(ls), gets "file.txt", answers "done".
// The Pi lines below were captured verbatim from `pi --mode json -p` (pi
// 0.80.6) and reduced; the Claude lines mirror stream-json. Keeping them real
// is the whole point — an invented fixture is how the first Pi adapter passed
// its own tests while speaking a schema Pi never emits.
const CLAUDE_WIRE = [
  `{"type":"system","subtype":"init","session_id":"sess-1"}`,
  `{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello"}]}}`,
  `{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t1","name":"bash","input":{"cmd":"ls"}}]}}`,
  `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"file.txt"}],"is_error":false}]}}`,
  // Verified against the real CLI: the final answer arrives as an assistant
  // message AND is repeated in the terminal result event (as it does for Pi).
  `{"type":"assistant","message":{"id":"m3","content":[{"type":"text","text":"done"}]}}`,
  `{"type":"result","result":"done","session_id":"sess-1","usage":{"input_tokens":10,"cache_read_input_tokens":5}}`,
].join("\n") + "\n";

const PI_WIRE = [
  `{"type":"session","version":3,"id":"sess-1","cwd":"/tmp"}`,
  `{"type":"agent_start"}`,
  // message_end fires for the user turn too — must not be forwarded.
  `{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"go"}]}}`,
  // Token deltas. If the adapter handles these too, the turn double-emits.
  `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"hel"}]},"assistantMessageEvent":{}}`,
  `{"type":"message_end","message":{"role":"assistant","responseId":"m1","content":[{"type":"thinking","thinking":"ignore me"},{"type":"text","text":"hello"}],"usage":{"input":10,"cacheRead":5,"cacheWrite":0}}}`,
  // tool_use rides the assistant message as a `toolCall` block with `arguments`.
  `{"type":"message_end","message":{"role":"assistant","responseId":"m2","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"cmd":"ls"}}],"usage":{"input":10,"cacheRead":5,"cacheWrite":0}}}`,
  // …so tool_execution_start is a hint only; synthesizing a block here double-emits.
  `{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"cmd":"ls"}}`,
  `{"type":"tool_execution_update","toolCallId":"t1","partialResult":{"content":[]}}`,
  `{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"content":[{"type":"text","text":"file.txt"}]},"isError":false}`,
  // …and the toolResult message_end must also be skipped.
  `{"type":"message_end","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"file.txt"}],"isError":false}}`,
  `{"type":"message_end","message":{"role":"assistant","responseId":"m3","content":[{"type":"text","text":"done"}],"usage":{"input":10,"cacheRead":5,"cacheWrite":0}}}`,
  `{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"go"}]},{"role":"assistant","content":[{"type":"text","text":"done"}]}],"willRetry":false}`,
  `{"type":"agent_settled"}`,
].join("\n") + "\n";

interface Case {
  name: string;
  rt: Runtime;
  wire: string;
  /** Flag the runtime uses to carry a resumed session id. */
  resumeFlag: string;
}

const MATRIX: Case[] = [
  { name: "claude", rt: new ClaudeRuntime(), wire: CLAUDE_WIRE, resumeFlag: "--resume" },
  { name: "pi", rt: new PiRuntime(), wire: PI_WIRE, resumeFlag: "--session" },
];

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const mid = Math.floor(bytes.length / 2);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.subarray(0, mid)); // split mid-line on purpose
      c.enqueue(bytes.subarray(mid));
      c.close();
    },
  });
}

interface Normalized {
  sessions: string[];
  blocks: RuntimeBlock[];
  toolResults: { id: string; content: unknown; isError: boolean }[];
  resultText: string;
  contextTokens: number;
}

async function normalize(rt: Runtime, wire: string): Promise<Normalized> {
  const out: Normalized = { sessions: [], blocks: [], toolResults: [], resultText: "", contextTokens: 0 };
  await rt.parseStream(streamOf(wire), {
    onSession: (id) => void out.sessions.push(id),
    // messageId is deliberately dropped: it's a runtime-private identifier.
    onAssistant: (blocks) => void out.blocks.push(...blocks),
    onToolResult: (id, content, isError) => void out.toolResults.push({ id, content, isError }),
    onResult: (ev) => {
      out.resultText = ev.text;
      out.contextTokens = ev.contextTokens;
    },
  });
  return out;
}

// --- stream normalization ---------------------------------------------------

describe("stream normalization is identical across runtimes", () => {
  for (const { name, rt, wire } of MATRIX) {
    test(`${name}: native wire → the same normalized events`, async () => {
      const got = await normalize(rt, wire);

      expect(got.sessions).toEqual(["sess-1"]);
      // thinking blocks dropped; tool_use carried once; final answer present.
      expect(got.blocks).toEqual([
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
        { type: "text", text: "done" },
      ]);
      // Tool-result payload is the raw block array for BOTH runtimes.
      expect(got.toolResults).toEqual([
        { id: "t1", content: [{ type: "text", text: "file.txt" }], isError: false },
      ]);
      expect(got.resultText).toBe("done");

      // Context tokens are a declared capability, not a universal guarantee.
      if (rt.capabilities.reportsContextTokens) {
        expect(got.contextTokens).toBeGreaterThan(0);
      } else {
        expect(got.contextTokens).toBe(0);
      }
    });
  }

  test("the two runtimes agree, field by field, on the shared surface", async () => {
    const [claude, pi] = await Promise.all(MATRIX.map((c) => normalize(c.rt, c.wire)));
    expect(pi.sessions).toEqual(claude.sessions);
    expect(pi.blocks).toEqual(claude.blocks);
    expect(pi.toolResults).toEqual(claude.toolResults);
    expect(pi.resultText).toEqual(claude.resultText);
    // Both wires encode input=10 + cacheRead=5 in their native usage shape.
    expect(pi.contextTokens).toEqual(claude.contextTokens);
  });
});

// --- parser robustness ------------------------------------------------------

describe("parseStream robustness", () => {
  for (const { name, rt } of MATRIX) {
    test(`${name}: malformed and unknown lines never throw`, async () => {
      const junk = [`not json`, `{"type":"totally_unknown"}`, `{}`, ``].join("\n") + "\n";
      await expect(normalize(rt, junk)).resolves.toBeDefined();
    });

    test(`${name}: a throwing handler does not abort the stream`, async () => {
      let sawResult = false;
      await rt.parseStream(streamOf(MATRIX.find((c) => c.rt === rt)!.wire), {
        onAssistant: () => {
          throw new Error("boom");
        },
        onResult: () => void (sawResult = true),
      });
      expect(sawResult).toBe(true);
    });
  }
});

// --- argv contract ----------------------------------------------------------

describe("argv contract", () => {
  for (const { name, rt } of MATRIX) {
    test(`${name}: argv starts with the executable and carries the prompt`, () => {
      const args = rt.buildRunArgs(spec({ prompt: "say hi" }));
      expect(args[0]).toBe(rt.executablePath);
      expect(args).toContain("say hi");
      expect(args.every((a) => typeof a === "string" && a.length > 0)).toBe(true);
    });

    test(`${name}: withOutputMode round-trips and preserves the prompt`, () => {
      const streamArgs = rt.buildRunArgs(spec({ outputMode: "stream", prompt: "P" }));
      const asText = rt.withOutputMode(streamArgs, "text");
      const backToStream = rt.withOutputMode(asText, "stream");
      expect(asText).toContain("P");
      expect(backToStream).toContain("P");
      expect(backToStream[0]).toBe(rt.executablePath);
      // Mode flags must not accumulate across conversions.
      expect(backToStream.filter((a) => a === "--mode" || a === "--output-format").length).toBeLessThanOrEqual(1);
    });

    test(`${name}: resume is emitted iff supportsResume, and stripResume removes it`, () => {
      const caps = rt.capabilities;
      const args = rt.buildRunArgs(spec({ resumeSessionId: "sess-9" }));
      const resumeFlag = MATRIX.find((c) => c.rt === rt)!.resumeFlag;

      if (caps.supportsResume) {
        expect(rt.resumeArgs("sess-9")).toEqual([resumeFlag, "sess-9"]);
        expect(args).toContain("sess-9");
        const stripped = rt.stripResume(args);
        expect(stripped).not.toContain(resumeFlag);
        expect(stripped).not.toContain("sess-9");
      } else {
        expect(args).not.toContain("sess-9");
      }
    });

    test(`${name}: plugin flags are forwarded iff supportsPlugins`, () => {
      const args = rt.buildRunArgs(spec({ jobsRepoArgs: ["--plugin-dir", "/p"] }));
      expect(args.includes("--plugin-dir")).toBe(rt.capabilities.supportsPlugins);
    });

    test(`${name}: appendSystemPrompt is passed through verbatim`, () => {
      const args = rt.buildRunArgs(spec({ appendSystemPrompt: "EXTRA" }));
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("EXTRA");
    });
  }
});

// --- capability coherence ---------------------------------------------------

describe("capabilities describe reality", () => {
  for (const { name, rt } of MATRIX) {
    test(`${name}: session predicates are total and never throw`, () => {
      expect(typeof rt.isCorruptedSession("", "")).toBe("boolean");
      expect(typeof rt.isStaleSession("", "")).toBe("boolean");
    });

    test(`${name}: an MCP-less runtime exposes an inert manager`, async () => {
      if (rt.capabilities.supportsMcpCli) return; // claude: would shell out; covered by e2e
      await expect(rt.mcp.list()).resolves.toEqual([]);
      await expect(rt.mcp.add({} as never)).resolves.toBeUndefined();
      await expect(rt.mcp.remove("x")).resolves.toBeUndefined();
    });

    test(`${name}: cleanSpawnEnv returns only string values`, () => {
      const env = rt.cleanSpawnEnv();
      expect(Object.values(env).every((v) => typeof v === "string")).toBe(true);
    });
  }

  test("each runtime advertises a distinct id", () => {
    const ids = MATRIX.map((c) => c.rt.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// --- known divergence -------------------------------------------------------

test("KNOWN DIVERGENCE: only Pi's parser flushes a trailing line with no newline", async () => {
  // parseClaudeStream leaves a final unterminated line in its buffer; Pi's
  // parser flushes it. Claude's CLI always terminates its last event with \n,
  // so this is latent, not a live bug — and fixing it would violate the
  // "ClaudeRuntime is a byte-identical extraction" constraint of this refactor.
  // Asserted so the divergence is tracked rather than rediscovered.
  const claude = MATRIX[0].rt;
  const pi = MATRIX[1].rt;

  const claudeNoNewline = `{"type":"result","result":"tail","session_id":"s"}`;
  const piNoNewline = `{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"tail"}]}]}`;

  expect((await normalize(claude, claudeNoNewline)).resultText).toBe(""); // dropped
  expect((await normalize(pi, piNoNewline)).resultText).toBe("tail"); // flushed
});
