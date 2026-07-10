# Pluggable exec runtime

**Status:** design (read-only exploration — no source changed)
**Date:** 2026-07-09
**Top constraint:** Claude behavior is preserved *exactly*. Phase 1 is a pure
extraction: same argv, same env, same stream parsing, same session/kill
semantics. `ERRANDD_RUNTIME` defaults to `claude` and the daemon behaves
bit-for-bit as it does today. Pi is a later phase that slots in behind the
interface.

---

## 1. Why

Today the daemon is welded to the `claude` CLI. The coupling is spread across
eight files with four independent copies of the "resolve executable + clean
env" logic, inline `claude`-specific argv construction in the hot path, and a
stream parser hard-coded to Claude Code's stream-json NDJSON schema. To add Pi
(a different coding-agent CLI with different stream/tool/session conventions)
we first isolate that surface behind one `Runtime` interface, extract Claude as
the default implementation with zero behavior change, then add Pi.

---

## 2. The current shell-out surface (inventory)

Every place the daemon spawns the coding agent, and what each depends on.

| # | File | Call | What it does | Runtime-specific bits |
|---|------|------|--------------|-----------------------|
| 1 | `spawn-config.ts` | — | Env / path / arg builders (extracted from runner) | `CLAUDE_EXECUTABLE`, `cleanSpawnEnv`, `buildChildEnv` (GLM `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`), `buildSecurityArgs` (`--dangerously-skip-permissions`, `--permission-mode`, `--tools`, `--allowedTools`, `--disallowedTools`), `stripResume` (`--resume`), `withOutputFormat` (`--output-format`) |
| 2 | `claude-spawn.ts` | `Bun.spawn(args)` | Spawn + NDJSON stream core | `spawnClaude`, `parseClaudeStream` (dispatches on `system`/`assistant`/`user`/`tool_use`/`result`), `appendModelArg` (GLM), `ContentBlock`/`ClaudeStreamEvent`, `mainActiveProcs`/`killActive`, `collectStream`, `formatToolCallSummary`, `extractToolResultText`, `MAX_OUTPUT_BYTES` |
| 3 | `runner.ts` | 5 spawn sites | The orchestrator. `runClaudeOnce` (buffered), `runClaudeStream` (streaming; captures `sessionId` + `result` + `contextTokens` from `usage`), `runCompact` (`-p /compact --output-format text --resume`), `execClaude` (builds `[exe, -p, prompt, --output-format stream-json, --verbose, …security, …repo]` + `--resume` + `--append-system-prompt`; fallback-model retry; corrupted-session + stale-session recovery; rate-limit; auto-compact), `streamClaude` (chat path; `--effort`; raw `Bun.spawn`; session-create from `system` event; `Agent` tool lifecycle), `runFork` (`--output-format json`, haiku, parses `json.result`), `bootstrap` | `CLAUDE_EXECUTABLE`, all Claude flags, `SIGNATURE_ERROR`/`STALE_SESSION_PATTERN` regexes, `usage.*_tokens` shape |
| 4 | `rotation.ts` | `Bun.spawn(["claude", …])` | Session summary before rotation: `-p <prompt> --resume <id> --output-format text` | hard-codes `"claude"`, own `cleanEnv` copy, `--resume`/`--output-format` |
| 5 | `jobsRepoPlugins.ts` | — | `getJobsRepoSpawnArgs()` → `--plugin-dir <dir>` per plugin, else `--add-dir <root>` | discovery is generic; the *flag names* are Claude-Code plugin loading |
| 6 | `mcp.ts` | `Bun.spawn([exe,"mcp",…])` | `claude mcp list/add/remove/get`; parses text output into `McpServer` | entirely Claude-Code MCP CLI; own exe-resolve + env copy |
| 7 | `haiku.ts` | `Bun.spawn([exe,-p,…])` | `runModelOneShot`/`runHaikuOneShot`: `-p <prompt> --model <m> --output-format text` (job-name gen, `filter_prompt`) | own exe-resolve + env copy |
| 8 | `claudeExe.ts` | — | 4th copy of `CLAUDE_EXECUTABLE` + `cleanSpawnEnv` | — |

**Peripheral — Claude-Code *plugin/marketplace* management, NOT the exec
runtime** (they drive `claude plugin …`, which has no Pi analog; leave them out
of the abstraction, gate behind a capability later):

- `jobsRepo.ts` `runClaude()` → `claude plugin marketplace …`
- `ui/services/claudePlugins.ts` `runCli()` → `claude plugin …`
- `commands/plugin-cli.ts` → `claude plugin …`
- `runtime.ts:456` → `claude plugin update` (self-update; note: `runtime.ts` is
  git-SHA / update helpers, **not** the exec runtime)
- `commands/discord.ts:555` → one-shot `claude --model sonnet --print
  --output-format text` thread-intent classifier (a stateless completion — a
  good candidate to route through `runtime.runOneShot()` once it exists)

### How a run flows today (the path to preserve)

1. `run()` / `runUserMessage()` / `streamUserMessage()` enqueue onto a serial
   `globalQueue` (or a per-`threadId` queue) → `execClaude` / `streamClaude`.
2. Resolve session: `getSession(agentName)` / `getThreadSession(threadId)` /
   fallback session. `isNew = !existing`.
3. Build argv: executable + `-p prompt` + `--output-format stream-json
   --verbose` + security flags + jobs-repo flags + (`--resume <id>` if
   resuming) + `--append-system-prompt <joined parts>`. Model appended via
   `appendModelArg` (GLM ⇒ omit `--model`, select via env).
4. Spawn with sanitized env (`cleanSpawnEnv` → `buildChildEnv`), optional
   `cwd` (agent workspace). Register proc in `mainActiveProcs`.
5. Stream stdout through `parseClaudeStream`; handlers capture `session_id`
   (from `system` init **and** `result`), accumulate assistant text, surface
   tool calls/results, read `usage` for `contextTokens`, deliver `onChunk` /
   `onToolEvent` to the UI.
6. On EOF: `await proc.exited`, unregister proc. Persist the session id for new
   sessions (`createSession`/`createThreadSession`/`createFallbackSession`).
7. Post-processing (all keyed off Claude-specific signals): rate-limit backoff,
   corrupted-session reset (`SIGNATURE_ERROR`), stale-session recovery
   (`STALE_SESSION_PATTERN`), turn tracking, compact-warn, size/timeout
   auto-compact + retry, watchdog.
8. `/kill` → `killActive()` kills every proc in `mainActiveProcs` (forks
   excluded — they never register).

**Session/resume is the load-bearing contract:** session ids are minted by the
CLI, surface *mid-stream*, are persisted by `sessions.ts` / `sessionManager.ts`,
and are replayed as `--resume <id>`. Any runtime must either honor this shape or
declare (via capability) that it can't, so the runner degrades gracefully.

---

## 3. The `Runtime` interface

New module tree `src/runtime/` (distinct from the existing `runtime.ts` git
helper — keep that file's name; the new code lives under the directory).

### 3.1 Normalized stream model

Callers stop seeing Claude's stream-json; they see this union. The Claude
implementation translates raw NDJSON → these; Pi translates its own format →
these.

```ts
// src/runtime/types.ts
export type RuntimeBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface RuntimeStreamHandlers {
  /** session id surfaced by the agent (init and/or terminal). May fire >1×. */
  onSession?(sessionId: string): void | Promise<void>;
  /** one assistant message's content blocks + its stable message id. */
  onAssistant?(blocks: RuntimeBlock[], messageId: string): void | Promise<void>;
  /** a tool result coming back (Claude: `user` msg w/ tool_result blocks). */
  onToolResult?(toolUseId: string, text: string, isError: boolean): void | Promise<void>;
  /** terminal event: final text + optional session id + context size. */
  onResult?(ev: { text: string; sessionId?: string; contextTokens: number }): void | Promise<void>;
  /** hint that a tool started (used only to unblock the chat UI early). */
  onToolUseHint?(): void | Promise<void>;
}
```

This is a strict superset of what the two live consumers
(`runClaudeStream`, `streamClaude`) actually read — so the extraction is
mechanical. `contextTokens` defaults to `0` for runtimes that don't report
usage (the size-based auto-compact simply never triggers — acceptable).

### 3.2 Run spec + capabilities

```ts
export interface RunSpec {
  prompt: string;
  outputMode: "stream" | "text" | "json"; // stream-json / text / json today
  model: string;                          // "" ⇒ runtime default
  resumeSessionId?: string;               // omit ⇒ new session
  security: SecurityConfig;
  jobsDirs: JobsRepoPlugin[];             // discovered plugins (generic)
  jobsAddDirs: string[];                  // fallback roots for --add-dir
  appendSystemPrompt?: string;
  effort?: string;                        // chat effort override
}

export interface RuntimeCapabilities {
  supportsResume: boolean;        // --resume <id>
  reportsContextTokens: boolean;  // usage → auto-compact size trigger
  supportsCompact: boolean;       // /compact
  supportsPlugins: boolean;       // --plugin-dir / --add-dir
  supportsMcpCli: boolean;        // `<exe> mcp …`
  supportsFallbackModel: boolean; // secondary model on rate-limit
  supportsEffort: boolean;        // --effort
}
```

### 3.3 The interface

```ts
export interface Runtime {
  readonly id: "claude" | "pi";
  readonly executablePath: string;            // resolved binary
  readonly capabilities: RuntimeCapabilities;

  // --- argv + env -------------------------------------------------------
  buildRunArgs(spec: RunSpec): string[];      // full argv incl. executable
  buildChildEnv(base: Record<string,string>, model: string, api: string): Record<string,string>;
  cleanSpawnEnv(): Record<string,string>;

  // --- spawn ------------------------------------------------------------
  spawn(args: string[], env: Record<string,string>, cwd?: string): Bun.Subprocess;

  // --- stream -----------------------------------------------------------
  parseStream(stdout: ReadableStream<Uint8Array>, handlers: RuntimeStreamHandlers): Promise<void>;

  // --- resume / arg surgery --------------------------------------------
  resumeArgs(sessionId: string): string[];    // ["--resume", id] for Claude
  stripResume(args: string[]): string[];
  withOutputMode(args: string[], mode: RunSpec["outputMode"]): string[];

  // --- error classification (runtime-specific error strings) -----------
  isCorruptedSession(stdout: string, stderr: string): boolean; // SIGNATURE_ERROR
  isStaleSession(stdout: string, stderr: string): boolean;     // STALE_SESSION_PATTERN

  // --- one-shot completion (haiku/discord-intent/summary) --------------
  runOneShot(prompt: string, model: string, opts?: { timeoutMs?: number; resumeSessionId?: string; outputMode?: "text"|"json" }): Promise<{ stdout: string; exitCode: number }>;

  // --- mcp --------------------------------------------------------------
  mcp: McpManager;   // list/add/remove/get — see mcp.ts, unchanged behavior
}
```

Kill tracking stays **runtime-agnostic** and shared (it operates on
`Bun.Subprocess`, not Claude specifics): `mainActiveProcs` + `killActive()` move
to `src/runtime/kill.ts`, re-exported from `claude-spawn.ts` and `runner.ts` so
importers are unchanged. Low risk, and it means `/kill` works across runtimes
for free.

---

## 4. Claude as the default implementation (pure extraction)

`src/runtime/claude/` maps 1:1 onto today's code — nothing is rewritten, only
relocated behind method calls:

| `Runtime` member | Today's code (source) |
|---|---|
| `executablePath` | `claudeExe.ts` `CLAUDE_EXECUTABLE` (the surviving copy) |
| `cleanSpawnEnv` | `spawn-config.ts` / `claudeExe.ts` `cleanSpawnEnv` |
| `buildChildEnv` | `spawn-config.ts` `buildChildEnv` (GLM base-url, auth token) |
| `buildRunArgs` | the inline `[exe,-p,prompt,--output-format,…]` in `execClaude`, plus `buildSecurityArgs` + `appendModelArg` (GLM) + jobs-repo flags |
| `spawn` | `claude-spawn.ts` `spawnClaude` |
| `parseStream` | thin adapter over `claude-spawn.ts` `parseClaudeStream`, translating raw `system/assistant/user/tool_use/result` → `RuntimeStreamHandlers` (see §5) |
| `resumeArgs` / `stripResume` / `withOutputMode` | `["--resume",id]` / `spawn-config.ts` `stripResume` / `withOutputFormat` |
| `isCorruptedSession` / `isStaleSession` | `runner.ts` `SIGNATURE_ERROR` / `STALE_SESSION_PATTERN` |
| `runOneShot` | `haiku.ts` `runModelOneShot` generalized (text/json, optional `--resume`, timeout) — also serves `rotation.ts` summary + `discord.ts` intent |
| `mcp` | `mcp.ts` `listMcpServers` / `addMcpServer` / `removeMcpServer` (unchanged) |
| `capabilities` | all `true` (Claude supports everything today) |

The Claude `parseStream` adapter (the one place raw→normalized translation
lives):

```ts
parseStream(stdout, h) {
  return parseClaudeStream(stdout, {
    onSystem:  (e) => { if (typeof e.session_id === "string") h.onSession?.(e.session_id); },
    onAssistant: (blocks, msgId) =>
      h.onAssistant?.(blocks.map(toRuntimeBlock).filter(Boolean), msgId),
    onUser: (blocks) => {
      for (const b of blocks) if (b.type === "tool_result" && b.tool_use_id)
        h.onToolResult?.(b.tool_use_id, extractToolResultText(b.content), !!b.is_error);
    },
    onToolUseEvent: () => h.onToolUseHint?.(),
    onResult: (e) => h.onResult?.({
      text: typeof e.result === "string" ? e.result : "",
      sessionId: typeof e.session_id === "string" ? e.session_id : undefined,
      contextTokens: readContextTokens(e),   // usage.input+cache_read+cache_creation
    }),
  });
}
```

`runClaudeStream`/`streamClaude` keep their exact per-event behavior by moving
it into `RuntimeStreamHandlers` (assistant-text accumulation, `onChunk`/
`onToolEvent`, `Agent` lifecycle, plugin observation, session persistence). The
`Agent`-tool detection (`block.name === "Agent"`) stays in the runner's handler
— it reads normalized `tool_use` blocks, so it's runtime-neutral.

---

## 5. Runtime selection

- New optional `Settings.runtime?: "claude" | "pi"` (default `"claude"`),
  parsed in `config.ts` from `ERRANDD_RUNTIME` (mirrors the existing
  `ERRANDD_MODEL` / `ERRANDD_SECURITY_LEVEL` pattern).
- `src/runtime/select.ts`:

  ```ts
  let cached: Runtime | null = null;
  export function getRuntime(): Runtime {
    if (cached) return cached;
    const id = (getSettings().runtime ?? process.env.ERRANDD_RUNTIME ?? "claude").toLowerCase();
    cached = id === "pi" ? new PiRuntime() : new ClaudeRuntime();
    return cached;
  }
  ```

- Every consumer replaces module-level `CLAUDE_EXECUTABLE` / `spawnClaude` /
  `appendModelArg` / inline-args usage with `const rt = getRuntime()` +
  `rt.*`. With `ERRANDD_RUNTIME` unset, `ClaudeRuntime` produces byte-identical
  argv/env/stream behavior.

---

## 6. File-change plan (dependency order, all behavior-preserving)

**Phase 0 — de-dup (no interface yet, shrinks the surface):**
1. Collapse the 4 copies of `resolveClaudeExecutable` + `cleanSpawnEnv`
   (`spawn-config.ts`, `mcp.ts`, `haiku.ts`, `claudeExe.ts`) to a single source
   in `claudeExe.ts`; others import it. Pure refactor, independently landable.

**Phase 1 — interface + shared kill:**
2. `src/runtime/types.ts` — `Runtime`, `RuntimeBlock`, `RuntimeStreamHandlers`,
   `RunSpec`, `RuntimeCapabilities`, `McpManager`. Types only, no Claude import.
3. `src/runtime/kill.ts` — move `mainActiveProcs` + `killActive` here;
   re-export from `claude-spawn.ts` (keeps `runner.ts` + `telegram.ts` imports
   working).

**Phase 2 — Claude implementation (extraction):**
4. `src/runtime/claude/stream.ts` — the raw→normalized adapter over
   `parseClaudeStream` (which stays in `claude-spawn.ts`, unchanged).
5. `src/runtime/claude/index.ts` — `ClaudeRuntime` wiring §4's table:
   `buildRunArgs` lifts the inline argv from `execClaude`; `runOneShot`
   generalizes `haiku.ts`.
6. `src/runtime/claude/mcp.ts` — re-export `mcp.ts` functions as the
   `McpManager` (or move the file; behavior unchanged).

**Phase 3 — selection:**
7. `config.ts` — add `runtime` to `Settings` + parse `ERRANDD_RUNTIME`.
8. `src/runtime/select.ts` — `getRuntime()` singleton.

**Phase 4 — rewire callers (the risky, behavior-critical step):**
9. `runner.ts` — `runClaudeOnce` / `runClaudeStream` / `runCompact` /
   `execClaude` / `streamClaude` / `runFork` / `bootstrap` all take
   `rt = getRuntime()` and call `rt.buildRunArgs` / `rt.spawn` /
   `rt.parseStream` / `rt.resumeArgs` / `rt.isCorruptedSession` /
   `rt.isStaleSession`. **Change nothing else.** Snapshot argv/env before and
   after (a golden test comparing `buildRunArgs(spec)` to the current literal
   array) to prove equivalence.
10. `rotation.ts` — summary via `rt.runOneShot(prompt, model, {resumeSessionId,
    outputMode:"text"})`; drop the local `"claude"` literal + `cleanEnv` copy.
11. `haiku.ts` — thin wrapper over `rt.runOneShot(prompt, model, "text")`.
12. `jobsRepoPlugins.ts` — keep discovery (`discoverPlugins`) generic; move the
    `--plugin-dir` / `--add-dir` flag emission into `ClaudeRuntime.buildRunArgs`
    (fed by `RunSpec.jobsDirs` / `jobsAddDirs`).
13. (optional) `discord.ts` intent classifier → `rt.runOneShot`.

**Phase 5 — Pi (separate PR, §8):** `src/runtime/pi/`.

Land Phase 0 alone, then 1–4 as one reviewable unit (they're only meaningful
together), verifying `bun run typecheck` + `bun run lint:eslint` green and the
argv golden test. CI's full suite (from a clean checkout) is the real gate.

---

## 7. Risk register

| Risk | Why it bites | Mitigation |
|---|---|---|
| **Stream normalization drift** | `runClaudeStream` and `streamClaude` read subtly different fields (usage tokens; top-level `tool_use` unblock; `Agent` lifecycle; msg-id chunk de-dup). A lossy normalized union changes UI/compaction behavior. | The `RuntimeStreamHandlers` union in §3.1 is a proven superset of both consumers; keep per-event *behavior* in the runner's handlers, only relocate *parsing*. Golden test: feed a recorded NDJSON transcript through old vs new, assert identical `onChunk`/`onToolEvent`/sessionId/contextTokens. |
| **Session / resume semantics** | Session ids surface mid-stream, are persisted, replayed as `--resume`, and drive fallback + corrupted + stale recovery. A runtime with a different session model breaks all of it silently. | `capabilities.supportsResume`; for Claude everything stays as-is. Runner branches that touch resume must consult the capability so a non-resuming runtime degrades to stateless instead of emitting a dead `--resume`. |
| **Kill tracking** | `/kill` must target main-queue procs and never forks. | Keep `mainActiveProcs`/`killActive` generic over `Bun.Subprocess` (Phase 1.3). Forks still bypass registration. Lowest-risk piece. |
| **Claude-specific error strings** | `SIGNATURE_ERROR`, `STALE_SESSION_PATTERN`, and `extractRateLimitMessage` are Anthropic-shaped. | Move the two session regexes behind `rt.isCorruptedSession/isStaleSession`. Rate-limit detection stays in `rate-limit.ts` for v1 (Claude-scoped) — note it as a follow-up to move behind the runtime. |
| **GLM env special-case** | `buildChildEnv` sets `ANTHROPIC_BASE_URL` + omits `--model` for `glm`; that's Claude-CLI-only. | Lives inside `ClaudeRuntime.buildChildEnv` + `buildRunArgs`. Pi handles model selection its own way. |
| **`--append-system-prompt` non-persistence** | Runner re-sends system prompt every `--resume` turn *because* Claude doesn't persist it. Pi may persist (or reject the flag). | It's an argv detail owned by `buildRunArgs`; Pi's builder decides. No runner change. |
| **Plugin/MCP flags** | `--plugin-dir` / `--add-dir` / `claude mcp` are Claude-Code-only. | `capabilities.supportsPlugins/supportsMcpCli`; Pi returns `[]` / a no-op `McpManager`. Peripheral `claude plugin …` callers stay out of scope. |

---

## 8. How Pi slots in (next phase)

`src/runtime/pi/` implements the same `Runtime`. What differs, concretely:

- **Executable/env:** `PI_EXECUTABLE` (`pi` on PATH); its own env sanitization —
  no `CLAUDECODE`/`CLAUDE_CODE_*` stripping, no GLM base-url; auth via Pi's
  mechanism.
- **argv:** Pi's own flags for prompt / non-interactive / model / output; likely
  no `--append-system-prompt`, `--plugin-dir`, `--verbose`, or Claude
  `--permission-mode`. `buildSecurityArgs` becomes Pi's tool-gating equivalent.
- **Stream format:** Pi's tool/stream conventions differ from Claude Code's
  stream-json (see `pi-tools.md`: Pi core ships no standard subagent/todo tool;
  `Agent`-style spawns come from optional `pi-subagents`). `parseStream`
  translates Pi's events → the same `RuntimeBlock`/handler union, so
  `runner.ts` is untouched. Tool names won't be Claude's PascalCase set —
  `formatToolCallSummary` should fall through gracefully (it already has a
  default branch).
- **Sessions/resume:** if Pi has no `--resume`, set `supportsResume:false`;
  runner runs stateless (no fallback/corrupted/stale recovery — those are
  Claude-only paths). If Pi resumes differently, `resumeArgs` encodes it.
- **Compaction / context tokens:** likely `reportsContextTokens:false` and
  `supportsCompact:false` → the size/timeout auto-compact simply never fires.
- **MCP:** if Pi has an MCP CLI, wrap it; else `supportsMcpCli:false` + no-op
  `McpManager` so the web MCP UI degrades cleanly.

The win: adding Pi touches only `src/runtime/pi/*`, the `getRuntime()` switch,
and `capabilities`. No change to `runner.ts`, `sessions.ts`, the queue, the
watchdog, or the UI.
