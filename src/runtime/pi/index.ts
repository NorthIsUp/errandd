// PiRuntime — the alternate coding-agent runtime (ERRANDD_RUNTIME=pi).
//
// Pi (https://pi.dev, earendil-works/pi) has its own CLI surface and event
// stream, so this is NOT a thin re-export of the Claude primitives: it builds
// Pi's own argv, leaves Pi's env alone, and parses Pi's NDJSON event stream
// (src/runtime/pi/stream.ts).
//
// Flags below are taken from Pi's documented CLI reference:
//   -p, --print                 Print response and exit
//   --mode json                 Output all events as JSON lines
//   --model <pattern>           provider/id, optional `:thinking` suffix
//   --thinking <level>          off|minimal|low|medium|high|xhigh|max
//   --session <path|id>         Use a specific session file or UUID
//   -c, --continue              Resume most recent
//   --append-system-prompt <t>  Extra system prompt
//   --skill <path> / -e         Skills / extensions (path-based, repeatable)
//
// Where Pi lacks a capability Claude has, the runtime degrades gracefully and
// advertises it via `capabilities` rather than faking it — the runner gates
// resume, plugins, MCP, and context-token compaction on those flags. Each gap
// carries a `ponytail:` comment.

import type {
  McpManager,
  OneShotOptions,
  OneShotResult,
  RunSpec,
  Runtime,
  RuntimeCapabilities,
  RuntimeOutputMode,
  RuntimeStreamHandlers,
  RuntimeSubprocess,
} from "../types";
import { parsePiRuntimeStream } from "./stream";

/** Resolve the Pi executable. Bare `pi` on PATH by default; overridable via
 *  PI_EXECUTABLE for non-standard installs. */
function resolvePiExecutable(): string {
  const override = process.env.PI_EXECUTABLE?.trim();
  return override || "pi";
}

/** Pi's documented `--thinking` levels. Anything else is dropped rather than
 *  passed through — an unknown level would make Pi exit non-zero. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Argv fragment selecting Pi's output mode.
 * - "text"            → `-p` alone (`--mode text` is the default)
 * - "stream" / "json" → `--mode json -p` (NDJSON event lines; see stream.ts)
 *
 * Pi has no `--format`/`--output-format` flag; `--mode` IS the flag, and `-p`
 * is what makes the run non-interactive. Without `-p`, pi only exits because
 * stdin happens to be closed — an implementation detail we don't want to lean
 * on, since a tool call then blocks forever waiting on an approval prompt.
 */
function outputModeArgs(mode: RuntimeOutputMode): string[] {
  return mode === "text" ? ["-p"] : ["--mode", "json", "-p"];
}

/** Remove any previously-emitted output-mode flags so they can be re-applied. */
function stripOutputMode(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--print") continue;
    if (a === "--mode") {
      i++; // skip its value
      continue;
    }
    out.push(a);
  }
  return out;
}

// ponytail: Pi documents "No MCP" as a deliberate design choice (it prefers CLI
// tools + skills), so MCP management is a no-op manager and `supportsMcpCli` is
// false. The web MCP UI routes through rt.mcp; against Pi it lists nothing and
// add/remove are inert rather than shelling out to a command that doesn't exist.
const noopMcp: McpManager = {
  list: () => Promise.resolve([]),
  add: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

export class PiRuntime implements Runtime {
  readonly id = "pi" as const;
  readonly executablePath = resolvePiExecutable();
  readonly capabilities: RuntimeCapabilities = {
    // Pi has real session resume: `--session <path|id>` (and `-c` for "most
    // recent"). We resume by explicit id, which is what the runner stores.
    supportsResume: true,
    // Verified against pi 0.80.6: each assistant message carries
    // `usage.{input,cacheRead,cacheWrite}`, so live-context size is reportable
    // and size-based auto-compaction works the same as it does for Claude.
    reportsContextTokens: true,
    // ponytail: jobsRepo plugin flags are Claude `--plugin-dir`-shaped. Pi does
    // have skills, but path-based via `--skill <path>` / `-e <source>`; the two
    // discovery models don't line up, so we don't forward the Claude flags.
    supportsPlugins: false,
    // ponytail: no MCP-registration CLI (see noopMcp).
    supportsMcpCli: false,
  };
  readonly mcp = noopMcp;

  buildRunArgs(spec: RunSpec): string[] {
    const args = [this.executablePath, ...outputModeArgs(spec.outputMode)];

    if (spec.model.trim()) args.push("--model", spec.model.trim());

    // Claude's `--effort` maps onto Pi's `--thinking`; both are ordinal levels.
    const effort = spec.effort?.trim().toLowerCase();
    if (effort && THINKING_LEVELS.has(effort)) args.push("--thinking", effort);

    if (spec.appendSystemPrompt) args.push("--append-system-prompt", spec.appendSystemPrompt);

    // Honored because supportsResume is true.
    if (spec.resumeSessionId?.trim()) args.push("--session", spec.resumeSessionId.trim());

    // ponytail: spec.jobsRepoArgs are Claude-shaped (supportsPlugins:false), and
    // spec.security has no Pi analogue — Pi gates tools via --tools/--exclude-tools
    // rather than a permission mode. Both intentionally dropped.

    // Prompt is positional (`pi [options] [messages...]`), so it goes last.
    args.push(spec.prompt);
    return args;
  }

  buildChildEnv(base: Record<string, string>, model: string, api: string): Record<string, string> {
    // ponytail: `api` is an ANTHROPIC_AUTH_TOKEN (a Claude concept), and Pi's
    // documented auth override is the `--api-key` flag — which this signature
    // can't reach. Rather than invent an env var name, we forward the base env
    // unchanged and let Pi read its own provider config. Thread `api` into
    // buildRunArgs as `--api-key` if per-run key override is ever needed.
    void model;
    void api;
    return { ...base };
  }

  cleanSpawnEnv(): Record<string, string> {
    // ponytail: no CLAUDECODE / CLAUDE_CODE_OAUTH_TOKEN reentry vars to strip
    // (that's a Claude CLI concern) — just copy the string-valued env.
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  spawn(args: string[], env: Record<string, string>, cwd?: string): RuntimeSubprocess {
    return Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env,
      ...(cwd ? { cwd } : {}),
    });
  }

  parseStream(stdout: ReadableStream<Uint8Array>, handlers: RuntimeStreamHandlers): Promise<void> {
    return parsePiRuntimeStream(stdout, handlers);
  }

  resumeArgs(sessionId: string): string[] {
    return sessionId.trim() ? ["--session", sessionId.trim()] : [];
  }

  stripResume(args: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--session" || args[i] === "--fork") {
        i++; // drop the flag and its value
        continue;
      }
      if (args[i] === "-c" || args[i] === "--continue") continue;
      out.push(args[i]);
    }
    return out;
  }

  withOutputMode(args: string[], mode: RuntimeOutputMode): string[] {
    // The prompt is positional and trails the flags, so re-apply the mode flags
    // at the front (right after the executable) rather than appending.
    const stripped = stripOutputMode(args);
    const [exe, ...rest] = stripped;
    return [exe, ...outputModeArgs(mode), ...rest];
  }

  isCorruptedSession(_stdout: string, _stderr: string): boolean {
    // ponytail: Pi has no thinking-block-signature corruption failure mode.
    // False keeps the runner's Claude-only corrupted-session reset dormant.
    return false;
  }

  isStaleSession(_stdout: string, stderr: string): boolean {
    // Pi resumes by session id, so a pruned/missing session file is reachable.
    // Keep the match narrow: only claim staleness when Pi says the session is
    // the thing that's missing, so unrelated ENOENTs don't wipe a live session.
    const s = stderr.toLowerCase();
    return s.includes("session") && (s.includes("not found") || s.includes("no such session"));
  }

  async runOneShot(opts: OneShotOptions): Promise<OneShotResult> {
    const args = [this.executablePath, ...outputModeArgs(opts.outputMode ?? "text")];
    if (opts.model?.trim()) args.push("--model", opts.model.trim());
    if (opts.resumeSessionId?.trim()) args.push("--session", opts.resumeSessionId.trim());
    args.push(opts.prompt);

    const proc = this.spawn(args, this.cleanSpawnEnv());
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);

    return { stdout, stderr, exitCode: proc.exitCode ?? 1, timedOut };
  }
}
