// Spawn + stream primitives for the `claude` CLI subprocess.
// Extracted from runner.ts. Behavior-preserving.
//
// The headline piece here is `parseClaudeStream`: a single NDJSON line-reader
// core that all three historical stream parsers (runClaudeStream,
// runClaudeStreaming, streamClaude) were independently re-implementing — and
// had drifted on. Callers pass a `StreamHandlers` bag of typed callbacks; the
// core owns the read loop, buffering, line splitting, and `JSON.parse`. Each
// caller keeps its own per-event behavior in its handlers, so this is a pure
// de-duplication of the boilerplate, not a behavior change.

import { buildChildEnv } from "./spawn-config";

// Cap stdout/stderr to prevent unbounded memory growth.
// 10 MB is far beyond any real Claude response; protects against runaway streams only.
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** A single content block inside a stream-json assistant/user message. */
export type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

/** A parsed stream-json NDJSON event (loose shape — fields vary by type). */
export type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: unknown;
  message?: { id?: string; content?: ContentBlock[] };
} & Record<string, unknown>;

// Track active main-queue subprocesses so /kill targets them exclusively.
// Using a Set because per-thread queues run in parallel — multiple main
// runs can be in-flight at the same time. Fork procs are excluded: they run
// outside the main queue and must not be killed by /kill.
export const mainActiveProcs = new Set<ReturnType<typeof Bun.spawn>>();

/** Kill all running main-queue claude subprocesses. Returns true if anything was killed. */
export function killActive(): boolean {
  if (mainActiveProcs.size === 0) return false;
  for (const proc of mainActiveProcs) {
    try { proc.kill(); } catch {}
  }
  mainActiveProcs.clear();
  return true;
}

export async function collectStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes < maxBytes) {
        const space = maxBytes - totalBytes;
        if (value.byteLength <= space) {
          chunks.push(value);
          totalBytes += value.byteLength;
        } else {
          chunks.push(value.subarray(0, space));
          totalBytes = maxBytes;
          // cap reached — keep draining without storing so the child process isn't blocked
        }
      }
      // beyond cap: read and discard to keep the pipe flowing
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function formatToolCallSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 50) => String(v ?? "").slice(0, max);
  switch (name) {
    case "Write":
    case "Edit":
    case "Read":    return `${name}(${s(input.file_path)})`;
    case "Bash":    return `Bash(${s(input.command, 60)})`;
    case "Grep":    return `Grep(${s(input.pattern)} in ${s(input.path ?? ".")})`;
    case "Glob":    return `Glob(${s(input.pattern)})`;
    case "WebSearch": return `WebSearch(${s(input.query)})`;
    case "WebFetch":  return `WebFetch(${s(input.url, 60)})`;
    default:        return `${name}(...)`;
  }
}

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === "text")
      .map(b => b.text ?? "")
      .join("");
  }
  return String(content ?? "");
}

/**
 * Append --model to a claude argv list, honoring the GLM special-case: when the
 * model is "glm" the model is selected via env (ANTHROPIC_BASE_URL), not the
 * --model flag, so we must NOT pass --model.
 */
export function appendModelArg(args: string[], model: string): string[] {
  const out = [...args];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") out.push("--model", model.trim());
  return out;
}

/** Spawn the claude CLI with the standard piped stdio + sanitized child env. */
export function spawnClaude(
  args: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  cwd?: string
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
    ...(cwd ? { cwd } : {}),
  });
}

/** Per-event handlers for {@link parseClaudeStream}. All optional. */
export interface StreamHandlers {
  /** Fired for every successfully-parsed NDJSON event (raw). */
  onEvent?: (event: ClaudeStreamEvent) => void | Promise<void>;
  /** Fired for `system` events (init / session_id carriers). */
  onSystem?: (event: ClaudeStreamEvent) => void | Promise<void>;
  /** Fired for `assistant` events, with the message's content blocks. */
  onAssistant?: (blocks: ContentBlock[], msgId: string, event: ClaudeStreamEvent) => void | Promise<void>;
  /** Fired for `user` events, with the message's content blocks (tool results). */
  onUser?: (blocks: ContentBlock[], event: ClaudeStreamEvent) => void | Promise<void>;
  /** Fired for a top-level `tool_use` event (some stream-json versions). */
  onToolUseEvent?: (event: ClaudeStreamEvent) => void | Promise<void>;
  /** Fired for the terminal `result` event. */
  onResult?: (event: ClaudeStreamEvent) => void | Promise<void>;
}

/**
 * Read a claude stream-json subprocess's stdout as NDJSON, parsing each line
 * and dispatching to the supplied handlers. Owns the read loop / line buffering
 * / JSON.parse; swallows per-line parse errors exactly as the original inline
 * loops did. Returns when stdout reaches EOF (does NOT await proc.exited).
 *
 * Handlers may be async; they are awaited in order so callers that mutate
 * session state inside a handler observe sequential ordering.
 */
export async function parseClaudeStream(
  stdout: ReadableStream<Uint8Array>,
  handlers: StreamHandlers
): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: ClaudeStreamEvent;
      try {
        event = JSON.parse(trimmed) as ClaudeStreamEvent;
      } catch {
        continue;
      }
      try {
        if (handlers.onEvent) await handlers.onEvent(event);
        switch (event.type) {
          case "system":
            if (handlers.onSystem) await handlers.onSystem(event);
            break;
          case "assistant":
            if (handlers.onAssistant && event.message?.content) {
              await handlers.onAssistant(event.message.content, event.message.id ?? "", event);
            }
            break;
          case "user":
            if (handlers.onUser) await handlers.onUser(event.message?.content ?? [], event);
            break;
          case "tool_use":
            if (handlers.onToolUseEvent) await handlers.onToolUseEvent(event);
            break;
          case "result":
            if (handlers.onResult) await handlers.onResult(event);
            break;
        }
      } catch {
        // Preserve the original loops' behavior: a throwing handler for one
        // line must not abort the whole stream.
      }
    }
  }
}
