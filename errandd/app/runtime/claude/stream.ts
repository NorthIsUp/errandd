// Raw stream-json → normalized RuntimeStreamHandlers adapter.
//
// This is the ONE place Claude's NDJSON schema is translated into the
// runtime-neutral RuntimeBlock / RuntimeStreamHandlers union. The read loop /
// line buffering / JSON.parse still lives in parseClaudeStream (claude-spawn),
// unchanged; this only maps event shapes → normalized callbacks. Per-event
// behavior stays in the runner's handlers, so the extraction is mechanical.

import { parseClaudeStream, type ClaudeStreamEvent } from "../../claude-spawn";
import type { RuntimeBlock, RuntimeStreamHandlers } from "../types";

/** Peak live-context tokens from a result event's `usage` (input + cache). */
function readContextTokens(e: ClaudeStreamEvent): number {
  const u = (e as { usage?: Record<string, unknown> }).usage;
  if (!u || typeof u !== "object") return 0;
  const num = (k: string) => (typeof u[k] === "number" ? u[k] : 0);
  return num("input_tokens") + num("cache_read_input_tokens") + num("cache_creation_input_tokens");
}

export function parseClaudeRuntimeStream(
  stdout: ReadableStream<Uint8Array>,
  h: RuntimeStreamHandlers,
): Promise<void> {
  return parseClaudeStream(stdout, {
    onSystem: (event) => {
      if (typeof event.session_id === "string") return h.onSession?.(event.session_id);
    },
    onAssistant: (blocks, msgId) => {
      if (!h.onAssistant) return;
      const mapped: RuntimeBlock[] = [];
      for (const b of blocks) {
        if (b.type === "text") {
          mapped.push({ type: "text", text: typeof b.text === "string" ? b.text : "" });
        } else if (b.type === "tool_use") {
          mapped.push({ type: "tool_use", id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} });
        }
      }
      return h.onAssistant(mapped, msgId);
    },
    onUser: async (blocks) => {
      if (!h.onToolResult) return;
      for (const b of blocks) {
        if (b.type === "tool_result") {
          await h.onToolResult(b.tool_use_id ?? "", b.content, b.is_error === true);
        }
      }
    },
    onToolUseEvent: () => h.onToolUseHint?.(),
    onResult: (event) => {
      if (!h.onResult) return;
      return h.onResult({
        text: typeof event.result === "string" ? event.result : "",
        sessionId: typeof event.session_id === "string" ? event.session_id : undefined,
        contextTokens: readContextTokens(event),
      });
    },
  });
}
