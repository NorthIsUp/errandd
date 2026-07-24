// The pluggable exec-runtime interface.
//
// Today the daemon shells out exclusively to the `claude` CLI. This module
// isolates that coupling behind one `Runtime` so a different coding-agent CLI
// (e.g. Pi) can slot in by implementing the same surface — without touching
// runner.ts / sessions / the queue / the UI.
//
// `ClaudeRuntime` (src/runtime/claude) is the default implementation and is a
// pure extraction of the existing behavior: byte-identical argv, env, stream
// handling, resume, kill, and MCP.

import type { SecurityConfig } from "../config";
import type { McpServer } from "../mcp";

// Runtime id. Historically a closed union ("claude" | "pi"); now open — any
// string a runtime registers under (see runtime/registry). Kept as a named
// alias for readability at the `Runtime.id` / `Settings.runtime` boundaries;
// the registry (registeredRuntimeIds()) is the source of truth for what's valid.
export type RuntimeId = string;

/** A spawned coding-agent subprocess with piped stdout/stderr. */
export type RuntimeSubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">;

// ---------------------------------------------------------------------------
// Normalized stream model
// ---------------------------------------------------------------------------
// Callers stop seeing Claude's raw stream-json NDJSON; they see this union.
// The Claude implementation translates raw events → these; Pi translates its
// own format → these. This is a superset of what the two live stream consumers
// (runClaudeStream, streamClaude) actually read.

/** A single assistant content block, normalized across runtimes. */
export type RuntimeBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** Token usage for one assistant turn or a whole run, normalized across
 *  runtimes. Every field is optional — a runtime populates only what its native
 *  events carry (Claude reports the full set; Pi omits `outputTokens` on some
 *  turns, etc.). This is the harness-neutral seam telemetry reads: gen_ai spans
 *  and metrics consume THIS, never the raw NDJSON. */
export interface RuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** input + output when the event reports a combined total; else derivable. */
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Model id + token usage for one assistant turn, surfaced alongside its blocks
 *  so observability reads the normalized seam instead of re-parsing the stream.
 *  Both fields are optional; a runtime supplies what its native turn event has. */
export interface RuntimeAssistantMeta {
  /** Response model id (e.g. "claude-opus-4-…") when the turn event carries it. */
  model?: string;
  usage?: RuntimeUsage;
  /** The turn's stop/finish reason (Claude `stop_reason`, e.g. "tool_use" /
   *  "end_turn") when the native event reports one. */
  stopReason?: string;
}

/** Terminal-event payload: final text, session id, peak context size, plus the
 *  run-level model / usage / cost when the runtime's result event reports them.
 *  `totalCostUsd` is threaded straight through for the pricing work (overhaul
 *  6/6) — errandd does not compute cost here. */
export interface RuntimeResult {
  text: string;
  sessionId?: string;
  contextTokens: number;
  /** Response model id from the terminal/result event, when present. */
  model?: string;
  usage?: RuntimeUsage;
  /** CLI-reported cost (Claude `total_cost_usd`); undefined when unreported. */
  totalCostUsd?: number;
}

/** Per-event handlers for {@link Runtime.parseStream}. All optional. */
export interface RuntimeStreamHandlers {
  /** Session id surfaced by the agent (init event). May fire more than once. */
  onSession?(sessionId: string): void | Promise<void>;
  /** One assistant message's content blocks + its stable message id. `meta`
   *  carries the turn's model id + token usage when the native event reports
   *  them (added for LLM-span telemetry; older callers ignore the 3rd arg). */
  onAssistant?(
    blocks: RuntimeBlock[],
    messageId: string,
    meta?: RuntimeAssistantMeta,
  ): void | Promise<void>;
  /** A tool result coming back. `content` is the raw payload (string or block
   *  array) so each consumer applies its own text extraction. */
  onToolResult?(toolUseId: string, content: unknown, isError: boolean): void | Promise<void>;
  /** Terminal event: final text + optional session id + peak context size +
   *  run-level model / usage / cost (see {@link RuntimeResult}). */
  onResult?(ev: RuntimeResult): void | Promise<void>;
  /** Hint that a tool started (used only to unblock the chat UI early). */
  onToolUseHint?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Run spec + capabilities
// ---------------------------------------------------------------------------

/** Output format for a run. Maps to `--output-format stream-json|text|json`. */
export type RuntimeOutputMode = "stream" | "text" | "json";

/** Everything needed to build a full run argv, runtime-independent. */
export interface RunSpec {
  prompt: string;
  outputMode: RuntimeOutputMode;
  /** "" ⇒ runtime default model. Runtime decides how to select (flag / env). */
  model: string;
  /** Omit ⇒ new session. Honored only when `capabilities.supportsResume`. */
  resumeSessionId?: string;
  security: SecurityConfig;
  /** Pre-discovered plugin/skill spawn flags (runtime-specific, opaque here).
   *  Discovery stays generic in jobsRepoPlugins.ts; the flag names are the
   *  runtime's concern. */
  jobsRepoArgs: string[];
  appendSystemPrompt?: string;
  /** Chat effort override (Claude `--effort`). */
  effort?: string;
  /** Per-run additional settings as a JSON string (Claude `--settings <json>`).
   *  Used for per-errand plugin overrides — a fully-merged `enabledPlugins` map
   *  layered on top of the project defaults for THIS spawn only, never written
   *  to the shared settings file. Runtimes without plugin support ignore it. */
  settingsJson?: string;
}

/** What a runtime can and can't do, so the runner degrades gracefully. */
export interface RuntimeCapabilities {
  /** Resume a prior session via id (`--resume`). */
  supportsResume: boolean;
  /** Reports usage tokens → drives size-based auto-compaction. */
  reportsContextTokens: boolean;
  /** Understands plugin/skill spawn flags. */
  supportsPlugins: boolean;
  /** Has an MCP management CLI (`<exe> mcp …`). */
  supportsMcpCli: boolean;
  /** Has an in-session compaction command (Claude `/compact`). Gates
   *  auto-compaction so the runner never invokes a Claude-only `/compact`
   *  under a runtime that can't honor it. */
  supportsCompaction: boolean;
}

/** Everything needed to build a fork-agent argv, runtime-independent. A fork is
 *  a lightweight, parallel watcher run outside the main queue. */
export interface ForkSpec {
  prompt: string;
  /** "" ⇒ runtime default model. */
  model: string;
  /** Extra system prompt appended for the fork's watcher persona. */
  systemPrompt: string;
  /** Pre-built runtime-specific security argv (opaque here). */
  securityArgs: string[];
}

/** Result of a one-shot completion. Callers decide how to treat each field. */
export interface OneShotResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Options for a one-shot completion (haiku / summary / filter). */
export interface OneShotOptions {
  prompt: string;
  /** "" / omit ⇒ runtime default model. */
  model?: string;
  resumeSessionId?: string;
  outputMode?: "text" | "json";
  timeoutMs?: number;
}

/** MCP server management, wrapping the runtime's MCP CLI. */
export interface McpManager {
  list(scope?: "user" | "project" | "local"): Promise<McpServer[]>;
  add(server: McpServer): Promise<void>;
  remove(name: string, scope?: "user" | "project" | "local"): Promise<void>;
}

// ---------------------------------------------------------------------------
// The runtime interface
// ---------------------------------------------------------------------------

export interface Runtime {
  readonly id: RuntimeId;
  /** Resolved binary path (or bare command resolved via PATH). */
  readonly executablePath: string;
  readonly capabilities: RuntimeCapabilities;

  // --- argv + env -------------------------------------------------------
  /** Full argv (including executable) for a streaming/buffered run. */
  buildRunArgs(spec: RunSpec): string[];
  /** Full argv for an in-session compaction run. Only reached when
   *  `capabilities.supportsCompaction`; runtimes without compaction throw. */
  buildCompactArgs(sessionId: string, securityArgs: string[]): string[];
  /** Full argv for a fork-agent run (see {@link ForkSpec}). */
  buildForkArgs(spec: ForkSpec): string[];
  /** Build the child env from a sanitized base (model/api selection). */
  buildChildEnv(base: Record<string, string>, model: string, api: string): Record<string, string>;
  /** A sanitized copy of the parent env, safe for a detached child. */
  cleanSpawnEnv(): Record<string, string>;

  // --- spawn ------------------------------------------------------------
  spawn(args: string[], env: Record<string, string>, cwd?: string): RuntimeSubprocess;

  // --- stream -----------------------------------------------------------
  parseStream(stdout: ReadableStream<Uint8Array>, handlers: RuntimeStreamHandlers): Promise<void>;

  // --- resume / arg surgery --------------------------------------------
  resumeArgs(sessionId: string): string[];
  stripResume(args: string[]): string[];
  withOutputMode(args: string[], mode: RuntimeOutputMode): string[];

  // --- error classification (runtime-specific error strings) -----------
  isCorruptedSession(stdout: string, stderr: string): boolean;
  isStaleSession(stdout: string, stderr: string): boolean;

  // --- one-shot completion (haiku / summary / filter) ------------------
  runOneShot(opts: OneShotOptions): Promise<OneShotResult>;

  // --- mcp --------------------------------------------------------------
  readonly mcp: McpManager;
}
