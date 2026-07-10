// Pi stream → normalized RuntimeStreamHandlers adapter.
//
// This is the ONE place Pi's stdout is translated into the runtime-neutral
// RuntimeBlock / RuntimeStreamHandlers union (the same union ClaudeRuntime
// produces). Pi is not wired through parseClaudeStream — that core is hard-coded
// to Claude's stream-json schema — so Pi owns its own NDJSON reader here and the
// two schemas never bleed into each other.
//
// Wire format verified by capturing `pi --mode json -p` against pi 0.80.6.
// A real turn with one tool call looks like:
//
//   {"type":"session","version":3,"id":"019f4a05-…","cwd":"/…"}
//   {"type":"agent_start"} {"type":"turn_start"}
//   {"type":"message_start","message":{…}}
//   {"type":"message_end","message":{"role":"user","content":[{"type":"text",…}]}}
//   {"type":"message_update",…}                        ← token deltas, ignored
//   {"type":"message_end","message":{"role":"assistant",
//        "content":[{"type":"thinking",…},{"type":"toolCall","id":"toolu_…",
//                    "name":"bash","arguments":{"command":"…"}}],
//        "usage":{"input":3525,"cacheRead":0,"cacheWrite":0,…},
//        "responseId":"msg_…"}}
//   {"type":"tool_execution_start","toolCallId":"toolu_…","toolName":"bash","args":{…}}
//   {"type":"tool_execution_update",…}                 ← partial result, ignored
//   {"type":"tool_execution_end","toolCallId":"toolu_…",
//        "result":{"content":[{"type":"text","text":"…"}]},"isError":false}
//   {"type":"message_end","message":{"role":"toolResult",…}}   ← skipped (not assistant)
//   {"type":"message_end","message":{"role":"assistant","content":[…text…],"usage":{…}}}
//   {"type":"agent_end","messages":[…]} {"type":"agent_settled"}
//
// Mapping decisions, each forced by the real wire above:
//  - Session id is `id` on the `session` header (there is no `session_id`).
//  - `message_end` fires for user and toolResult messages too — only `role ===
//    "assistant"` is forwarded.
//  - tool_use blocks come from the assistant message's `toolCall` block
//    (`{id,name,arguments}`), NOT synthesized from `tool_execution_start`.
//    Emitting both would double every tool call. `tool_execution_start` is
//    therefore only a UI hint, and the assistant→toolResult ordering already
//    matches Claude's.
//  - `tool_execution_end.result` is `{content:[…blocks]}`; we forward
//    `result.content` so the payload shape matches Claude's raw tool_result
//    content (string | block array).
//  - `thinking` blocks are dropped (Claude's thinking isn't surfaced either).
//  - Message id is `responseId`; Pi has no `message.id`.
//  - Token usage rides each assistant message (`usage.input/cacheRead/
//    cacheWrite`), not the terminal event — so we latch the last one and report
//    it at `agent_end`, mirroring Claude's result-event usage.

import type { RuntimeBlock, RuntimeStreamHandlers } from "../types";

/** A loosely-typed Pi NDJSON event. Fields vary by `type`. */
type PiEvent = {
  type?: string;
  id?: unknown;
  message?: unknown;
  messages?: unknown;
  toolCallId?: unknown;
  result?: unknown;
  isError?: unknown;
} & Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Live-context tokens from a Pi assistant message's `usage`. Mirrors Claude's
 *  input + cache_read + cache_creation sum. */
function readContextTokens(usage: unknown): number {
  const u = rec(usage);
  const num = (k: string) => (typeof u[k] === "number" ? (u[k]) : 0);
  return num("input") + num("cacheRead") + num("cacheWrite");
}

/** Map a Pi AgentMessage's `content` → normalized RuntimeBlocks. */
function mapBlocks(content: unknown): RuntimeBlock[] {
  const mapped: RuntimeBlock[] = [];
  if (typeof content === "string") {
    if (content) mapped.push({ type: "text", text: content });
    return mapped;
  }
  if (!Array.isArray(content)) return mapped;
  for (const raw of content) {
    const b = rec(raw);
    switch (str(b.type)) {
      case "text": {
        const text = str(b.text);
        if (text) mapped.push({ type: "text", text });
        break;
      }
      case "toolCall": {
        mapped.push({
          type: "tool_use",
          id: str(b.id),
          name: str(b.name),
          // Real field is `arguments`; `args`/`input` accepted defensively.
          input: rec(b.arguments ?? b.args ?? b.input),
        });
        break;
      }
      default:
        // `thinking` and anything else Pi adds later — ignored.
        break;
    }
  }
  return mapped;
}

/** Concatenated text of an AgentMessage (thinking/toolCall excluded). */
function messageText(msg: Record<string, unknown>): string {
  return mapBlocks(msg.content)
    .filter((b): b is Extract<RuntimeBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Per-stream mutable state. Usage rides assistant messages, not `agent_end`. */
interface PiStreamState {
  contextTokens: number;
}

/** Dispatch one already-parsed Pi event. Exported for tests. */
export async function dispatchPiEvent(
  e: PiEvent,
  h: RuntimeStreamHandlers,
  state: PiStreamState = { contextTokens: 0 },
): Promise<void> {
  switch (str(e.type)) {
    case "session": {
      const id = str(e.id);
      if (id) await h.onSession?.(id);
      return;
    }

    case "message_end": {
      const msg = rec(e.message);
      // `message_end` also fires for role "user" and "toolResult".
      if (str(msg.role) !== "assistant") return;

      // Latch usage — the terminal `agent_end` carries none.
      const tokens = readContextTokens(msg.usage);
      if (tokens > 0) state.contextTokens = tokens;

      if (!h.onAssistant) return;
      const blocks = mapBlocks(msg.content);
      if (blocks.length) await h.onAssistant(blocks, str(msg.responseId));
      return;
    }

    case "tool_execution_start": {
      // Hint only. The tool_use block itself already arrived on the assistant
      // message_end above; synthesizing one here would double-emit it.
      await h.onToolUseHint?.();
      return;
    }

    case "tool_execution_end": {
      if (!h.onToolResult) return;
      // `result` is {content:[…blocks]}; forward `.content` so the shape matches
      // Claude's raw tool_result payload. Fall back to the whole value.
      const result = e.result;
      const inner = rec(result).content;
      await h.onToolResult(str(e.toolCallId), inner ?? result, e.isError === true);
      return;
    }

    case "agent_end": {
      if (!h.onResult) return;
      const msgs = Array.isArray(e.messages) ? e.messages : [];
      let text = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = rec(msgs[i]);
        if (str(msg.role) !== "assistant") continue;
        const t = messageText(msg);
        if (t) {
          text = t;
          break;
        }
      }
      await h.onResult({ text, contextTokens: state.contextTokens });
      return;
    }

    default:
      // agent_start / turn_* / message_start / message_update /
      // tool_execution_update / queue_update / compaction_* / auto_retry_* /
      // agent_settled — ignored, mirroring the Claude core's silent skip.
      return;
  }
}

/**
 * Read Pi's stdout as NDJSON, parse each line, and dispatch to the normalized
 * handlers. Owns the read loop / line buffering / JSON.parse; swallows per-line
 * parse errors and per-handler throws so one bad line never aborts the stream
 * (same contract as parseClaudeStream). Returns at stdout EOF.
 *
 * Pi frames records as strict LF-delimited JSONL, so we split on "\n" only.
 */
export async function parsePiRuntimeStream(
  stdout: ReadableStream<Uint8Array>,
  h: RuntimeStreamHandlers,
): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  const state: PiStreamState = { contextTokens: 0 };
  let buf = "";
  const flush = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: PiEvent;
    try {
      event = JSON.parse(trimmed) as PiEvent;
    } catch {
      return;
    }
    try {
      await dispatchPiEvent(event, h, state);
    } catch {
      // A throwing handler for one line must not abort the whole stream.
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) await flush(line);
  }
  // Flush a trailing line with no final newline.
  await flush(buf);
}
