import { spawn } from "bun";
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
import { parseCodexRuntimeStream } from "./stream";

const noMcp: McpManager = {
  list: () => Promise.resolve([]),
  add: () => Promise.reject(new Error("Configure Codex MCP servers in ~/.codex/config.toml")),
  remove: () => Promise.reject(new Error("Configure Codex MCP servers in ~/.codex/config.toml")),
};
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

/** Codex CLI integration. Wire contract: https://learn.chatgpt.com/docs/non-interactive-mode */
export class CodexRuntime implements Runtime {
  readonly id = "codex";
  readonly executablePath = process.env.CODEX_EXECUTABLE?.trim() || "codex";
  readonly capabilities: RuntimeCapabilities = {
    supportsResume: true,
    // exec usage is cumulative across model requests, not the live context size.
    reportsContextTokens: false,
    supportsPlugins: false,
    supportsMcpCli: false,
    supportsCompaction: false,
  };
  readonly mcp = noMcp;

  buildRunArgs(spec: RunSpec): string[] {
    const args = [
      this.executablePath,
      "exec",
      "--skip-git-repo-check",
      "-c",
      'approval_policy="never"',
    ];
    // Config overrides work for both exec and exec resume; --sandbox is not
    // accepted after the resume subcommand by all supported CLI versions.
    const sandbox =
      spec.security.level === "unrestricted"
        ? "danger-full-access"
        : spec.security.level === "moderate"
          ? "workspace-write"
          : "read-only";
    args.push("-c", `sandbox_mode=${JSON.stringify(sandbox)}`);
    if (spec.security.level === "locked" || spec.security.level === "strict") {
      args.push("-c", "features.shell_tool=false", "-c", 'web_search="disabled"');
    }
    if (spec.outputMode !== "text") {
      args.splice(2, 0, "--json");
    }
    if (spec.model.trim()) {
      args.push("--model", spec.model.trim());
    }
    const effort = spec.effort?.trim().toLowerCase();
    if (effort && EFFORTS.has(effort)) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    }
    if (spec.appendSystemPrompt) {
      args.push("-c", `developer_instructions=${JSON.stringify(spec.appendSystemPrompt)}`);
    }
    if (spec.resumeSessionId?.trim()) {
      args.push(...this.resumeArgs(spec.resumeSessionId));
    }
    // End options explicitly: a user prompt beginning with '-' is still text.
    args.push("--", spec.prompt);
    return args;
  }

  buildCompactArgs(): string[] {
    throw new Error("Codex exec does not expose in-session compaction");
  }

  buildForkArgs(spec: ForkSpec): string[] {
    return this.buildRunArgs({
      prompt: spec.prompt,
      model: spec.model,
      outputMode: "stream",
      appendSystemPrompt: spec.systemPrompt,
      jobsRepoArgs: [],
      security: { level: "locked", allowedTools: [], disallowedTools: [] },
    });
  }

  buildChildEnv(base: Record<string, string>, _model: string, api: string): Record<string, string> {
    return { ...base, ...(api.trim() ? { CODEX_API_KEY: api.trim() } : {}) };
  }

  cleanSpawnEnv(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  spawn(args: string[], env: Record<string, string>, cwd?: string): RuntimeSubprocess {
    return spawn(args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
      ...(cwd ? { cwd } : {}),
    });
  }

  parseStream(stdout: ReadableStream<Uint8Array>, handlers: RuntimeStreamHandlers): Promise<void> {
    return parseCodexRuntimeStream(stdout, handlers);
  }

  resumeArgs(sessionId: string): string[] {
    return sessionId.trim() ? ["resume", sessionId.trim()] : [];
  }

  stripResume(args: string[]): string[] {
    const end = args.indexOf("--");
    const idx = args.findIndex(
      (arg, index) =>
        index > 1 &&
        arg === "resume" &&
        !["-c", "--config", "--model", "-m"].includes(args[index - 1]),
    );
    if (idx < 0 || (end >= 0 && idx >= end)) {
      return [...args];
    }
    return [...args.slice(0, idx), ...args.slice(idx + 2)];
  }

  withOutputMode(args: string[], mode: RuntimeOutputMode): string[] {
    const end = args.indexOf("--");
    const optionsEnd = end < 0 ? args.length - 1 : end;
    const options = args
      .slice(0, optionsEnd)
      .filter(
        (arg, index) =>
          arg !== "--json" || ["--model", "-m", "-c", "--config"].includes(args[index - 1]),
      );
    if (mode !== "text") {
      options.splice(2, 0, "--json");
    }
    return [...options, ...args.slice(optionsEnd)];
  }

  isCorruptedSession(): boolean {
    return false;
  }
  isStaleSession(stdout: string, stderr: string): boolean {
    return /(?:no (?:saved )?(?:session|rollout|thread) found|(?:session|rollout|thread)[^\n]*(?:not found|does not exist))/i.test(
      `${stdout}\n${stderr}`,
    );
  }

  async runOneShot(opts: OneShotOptions): Promise<OneShotResult> {
    const args = this.buildRunArgs({
      prompt: opts.prompt,
      model: opts.model ?? "",
      outputMode: opts.outputMode ?? "text",
      resumeSessionId: opts.resumeSessionId,
      jobsRepoArgs: [],
      security: { level: "locked", allowedTools: [], disallowedTools: [] },
    });
    const proc = this.spawn(args, this.cleanSpawnEnv());
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* The process may have already exited. */
      }
    }, opts.timeoutMs ?? 30_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
}
