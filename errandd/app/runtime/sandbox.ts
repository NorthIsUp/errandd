// Every runtime spawns through `spawnRuntimeProcess`. With `settings.sandbox`
// set, the command runs in a kubernetes-sigs/agent-sandbox pod via sandbox.sh
// instead of on the host; stdout is the CLI's own stream either way.
// https://github.com/kubernetes-sigs/agent-sandbox

import { homedir } from "os";
import { join } from "path";
import { asRecord, peekSettings } from "../config";
import { resolveMcpServers } from "../mcpRegister";
import { buildSandboxKit, EMPTY_KIT, type SandboxKit } from "./sandboxKit";
import type { RuntimeSubprocess } from "./types";

export interface SandboxConfig {
  warmPool: string;
  namespace: string;
  /** kubeconfig context; current context when unset. */
  context?: string;
}

const SCRIPT = join(import.meta.dir, "sandbox.sh");

// Exactly what the runtimes and telemetry set; anything else (host paths) would break the pod.
const FORWARDED_ENV =
  /^(ANTHROPIC_(AUTH_TOKEN|BASE_URL|API_KEY)|API_TIMEOUT_MS|CODEX_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_ENABLE_TELEMETRY|CLAUDE_CODE_ENHANCED_TELEMETRY_BETA|OTEL_[A-Z_]+)$/;

const CLEANUP_GRACE_MS = 10 * 60_000;

export function parseSandbox(raw: unknown): SandboxConfig | undefined {
  const r = asRecord(raw);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const warmPool = str(r.warmPool);
  if (!warmPool) return undefined;
  const namespace = str(r.namespace) || "default";
  const context = str(r.context);
  return context ? { warmPool, namespace, context } : { warmPool, namespace };
}

export function spawnRuntimeProcess(
  argv: string[],
  env: Record<string, string>,
  cwd?: string,
): RuntimeSubprocess {
  const settings = peekSettings();
  if (!settings?.sandbox) {
    return Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, ...(cwd ? { cwd } : {}) });
  }
  // The spawn site doesn't know its timeout category, so outlive the longest one.
  const { telegram, heartbeat, job, default: other } = settings.timeouts;
  const lifetimeMs = Math.max(telegram, heartbeat, job, other) * 60_000 + CLEANUP_GRACE_MS;
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const kit = buildSandboxKit(argv[0] ?? "", resolveMcpServers(settings.mcpServers, env), env, claudeDir, ghToken());
  const wrapped = sandboxCommand(argv, env, settings.sandbox, lifetimeMs, cwd, kit);
  return Bun.spawn(wrapped.argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: wrapped.env });
}

/** The daemon's current GitHub App token (appAuth keeps gh logged in), or null. */
function ghToken(): string | null {
  try {
    const r = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const token = r.stdout.toString().trim();
    return r.exitCode === 0 && token ? token : null;
  } catch {
    return null;
  }
}

/** Host argv/env that run `args` in a freshly claimed pod. `lifetimeMs` backs
 *  up the script's trap: the controller deletes the claim if the daemon dies. */
export function sandboxCommand(
  args: string[],
  env: Record<string, string>,
  cfg: SandboxConfig,
  lifetimeMs: number,
  cwd = "",
  kit: SandboxKit = EMPTY_KIT,
  now = Date.now(),
): { argv: string[]; env: Record<string, string> } {
  const [exe = "", ...rest] = args;
  const claim = {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxClaim",
    metadata: { generateName: "errandd-" },
    spec: {
      warmPoolRef: { name: cfg.warmPool },
      lifecycle: { shutdownPolicy: "Delete", shutdownTime: new Date(now + lifetimeMs).toISOString() },
    },
  };
  const forwarded: string[] = [];
  const candidates = [...Object.entries(env).filter(([k]) => FORWARDED_ENV.test(k)), ...Object.entries(kit.env)];
  for (const [k, v] of candidates) {
    if (v.includes("\n")) {
      console.warn(`[sandbox] not forwarding ${k}: multi-line values can't cross exec stdin`);
      continue;
    }
    forwarded.push(`${k}=${v}`);
  }
  return {
    // The host's absolute CLI path means nothing in the pod; use its basename.
    argv: ["sh", SCRIPT, exe.split("/").pop() ?? exe, ...kit.args, ...rest],
    env: {
      ...env,
      ERRANDD_SB_NAMESPACE: cfg.namespace,
      ERRANDD_SB_CONTEXT: cfg.context ?? "",
      ERRANDD_SB_CLAIM: JSON.stringify(claim),
      ERRANDD_SB_ENV: forwarded.join("\n"),
      ERRANDD_SB_CWD: cwd,
      ERRANDD_SB_CLAUDE_DIR: kit.claudeDir,
      ERRANDD_SB_KIT: kit.paths.join("\n"),
    },
  };
}
