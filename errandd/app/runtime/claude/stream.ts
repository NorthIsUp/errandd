// Raw stream-json → normalized RuntimeStreamHandlers adapter.
//
// This is the ONE place Claude's NDJSON schema is translated into the
// runtime-neutral RuntimeBlock / RuntimeStreamHandlers union. The read loop /
// line buffering / JSON.parse still lives in parseClaudeStream (claude-spawn),
// unchanged; this only maps event shapes → normalized callbacks. Per-event
// behavior stays in the runner's handlers, so the extraction is mechanical.

import { parseClaudeStream, type ClaudeStreamEvent } from "../../claude-spawn";
import type { RuntimeAssistantMeta, RuntimeBlock, RuntimeStreamHandlers, RuntimeUsage } from "../types";

const numAt = (u: Record<string, unknown> | undefined, k: string): number =>
  u && typeof u[k] === "number" ? u[k] : 0;

/** Peak live-context tokens from a usage object (input + cache read + cache
 *  creation) — the size the model actually processed on this turn. */
function contextTokensOf(u: Record<string, unknown> | undefined): number {
  return (
    numAt(u, "input_tokens") +
    numAt(u, "cache_read_input_tokens") +
    numAt(u, "cache_creation_input_tokens")
  );
}

/** Map Claude's snake_case usage → the normalized {@link RuntimeUsage}. Returns
 *  undefined when the event carries no usage, so callers can omit the field. */
function mapUsage(u: Record<string, unknown> | undefined): RuntimeUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const input = numAt(u, "input_tokens");
  const output = numAt(u, "output_tokens");
  const cacheRead = numAt(u, "cache_read_input_tokens");
  const cacheCreation = numAt(u, "cache_creation_input_tokens");
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

/** Best-effort response model from a result event: `modelUsage` is keyed by
 *  model name (`{"claude-…":{…}}`), so the first key is the run's model. */
function resultModel(e: ClaudeStreamEvent): string | undefined {
  const mu = (e as { modelUsage?: Record<string, unknown> }).modelUsage;
  if (mu && typeof mu === "object") {
    const first = Object.keys(mu)[0];
    if (first) return first;
  }
  return typeof e.message?.model === "string" ? e.message.model : undefined;
}

export function parseClaudeRuntimeStream(
  stdout: ReadableStream<Uint8Array>,
  h: RuntimeStreamHandlers,
): Promise<void> {
  return parseClaudeStream(stdout, {
    onSystem: (event) => {
      if (typeof event.session_id === "string") return h.onSession?.(event.session_id);
    },
    onAssistant: (blocks, msgId, event) => {
      if (!h.onAssistant) return;
      const mapped: RuntimeBlock[] = [];
      for (const b of blocks) {
        if (b.type === "text") {
          mapped.push({ type: "text", text: typeof b.text === "string" ? b.text : "" });
        } else if (b.type === "tool_use") {
          mapped.push({ type: "tool_use", id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} });
        }
      }
      // Model + usage ride the assistant message; surface them on the normalized
      // seam so per-turn gen_ai spans read here instead of the raw NDJSON.
      const meta: RuntimeAssistantMeta = {};
      if (typeof event.message?.model === "string") meta.model = event.message.model;
      const usage = mapUsage(event.message?.usage);
      if (usage) meta.usage = usage;
      if (typeof event.message?.stop_reason === "string") meta.stopReason = event.message.stop_reason;
      return h.onAssistant(mapped, msgId, meta);
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
      const usageRaw = (event as { usage?: Record<string, unknown> }).usage;
      const cost = (event as { total_cost_usd?: unknown }).total_cost_usd;
      const model = resultModel(event);
      const usage = mapUsage(usageRaw);
      return h.onResult({
        text: typeof event.result === "string" ? event.result : "",
        sessionId: typeof event.session_id === "string" ? event.session_id : undefined,
        contextTokens: contextTokensOf(usageRaw),
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
        ...(typeof cost === "number" ? { totalCostUsd: cost } : {}),
      });
    },
  });
}
