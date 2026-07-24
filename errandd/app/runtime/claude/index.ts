// ClaudeRuntime — the default runtime.
//
// A pure extraction of the existing `claude` CLI coupling behind the Runtime
// interface. Every method delegates to the already-extracted primitives
// (spawn-config, claude-spawn, mcp), so with ERRANDD_RUNTIME unset the daemon
// produces byte-identical argv / env / stream behavior.

import {
  CLAUDE_EXECUTABLE,
  cleanSpawnEnv,
  buildChildEnv,
  buildSecurityArgs,
  stripResume,
  withOutputFormat,
} from "../../spawn-config";
import { appendModelArg } from "../../claude-spawn";
import { listMcpServers, addMcpServer, removeMcpServer, type McpServer } from "../../mcp";
import { parseClaudeRuntimeStream } from "./stream";
import type {
  ForkSpec,
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

// Claude Code prints this when a resumed session's thinking-block signature is
// invalid — the session is corrupted and must be reset.
const SIGNATURE_ERROR = /Invalid.*signature.*thinking block/i;

// Claude Code prints this when --resume references a session it no longer has
// on disk (cleared, expired, compacted away, moved machines) — the cached id
// is dead and the only recovery is to drop --resume and start fresh.
const STALE_SESSION_PATTERN = /No conversation found with session ID/i;

/** Map a normalized output mode to Claude's --output-format value. */
function outputFormatFlag(mode: RuntimeOutputMode): string {
  return mode === "stream" ? "stream-json" : mode;
}

const mcp: McpManager = {
  list: (scope?: "user" | "project" | "local") => listMcpServers(scope),
  add: (server: McpServer) => addMcpServer(server),
  remove: (name: string, scope?: "user" | "project" | "local") => removeMcpServer(name, scope),
};

export class ClaudeRuntime implements Runtime {
  readonly id = "claude" as const;
  readonly executablePath = CLAUDE_EXECUTABLE;
  readonly capabilities: RuntimeCapabilities = {
    supportsResume: true,
    reportsContextTokens: true,
    supportsPlugins: true,
    supportsMcpCli: true,
    supportsCompaction: true,
  };
  readonly mcp = mcp;

  buildRunArgs(spec: RunSpec): string[] {
    const args = [
      this.executablePath,
      "-p",
      spec.prompt,
      "--output-format",
      outputFormatFlag(spec.outputMode),
    ];
    // stream-json only produces output in print (-p) mode with --verbose.
    if (spec.outputMode === "stream") args.push("--verbose");
    args.push(...buildSecurityArgs(spec.security), ...spec.jobsRepoArgs);
    if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
    // Per-run additional settings (e.g. per-errand plugin overrides). Layered on
    // top of the project's settings sources for this spawn only.
    if (spec.settingsJson) args.push("--settings", spec.settingsJson);
    // --append-system-prompt does not persist across --resume, so callers
    // re-send it every turn; it's just an argv detail here.
    if (spec.appendSystemPrompt) args.push("--append-system-prompt", spec.appendSystemPrompt);
    // Model appended last, honoring the GLM special-case (selected via env, no
    // --model flag).
    const withModel = appendModelArg(args, spec.model);
    if (spec.effort?.trim()) withModel.push("--effort", spec.effort.trim());
    return withModel;
  }

  buildCompactArgs(sessionId: string, securityArgs: string[]): string[] {
    return [
      this.executablePath,
      "-p",
      "/compact",
      "--output-format",
      "text",
      "--resume",
      sessionId,
      ...securityArgs,
    ];
  }

  buildForkArgs(spec: ForkSpec): string[] {
    return [
      this.executablePath,
      "-p",
      spec.prompt,
      "--output-format",
      "json",
      ...spec.securityArgs,
      "--model",
      spec.model,
      "--append-system-prompt",
      spec.systemPrompt,
    ];
  }

  buildChildEnv(base: Record<string, string>, model: string, api: string): Record<string, string> {
    return buildChildEnv(base, model, api);
  }

  cleanSpawnEnv(): Record<string, string> {
    return cleanSpawnEnv();
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
    return parseClaudeRuntimeStream(stdout, handlers);
  }

  resumeArgs(sessionId: string): string[] {
    return ["--resume", sessionId];
  }

  stripResume(args: string[]): string[] {
    return stripResume(args);
  }

  withOutputMode(args: string[], mode: RuntimeOutputMode): string[] {
    return withOutputFormat(args, outputFormatFlag(mode));
  }

  isCorruptedSession(stdout: string, stderr: string): boolean {
    return SIGNATURE_ERROR.test(stdout + stderr);
  }

  isStaleSession(stdout: string, stderr: string): boolean {
    return STALE_SESSION_PATTERN.test(stderr) || STALE_SESSION_PATTERN.test(stdout);
  }

  async runOneShot(opts: OneShotOptions): Promise<OneShotResult> {
    const mode = opts.outputMode ?? "text";
    const args = [this.executablePath, "-p", opts.prompt];
    if (opts.model?.trim()) args.push("--model", opts.model.trim());
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    args.push("--output-format", mode);

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
