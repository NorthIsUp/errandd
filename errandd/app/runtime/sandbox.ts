// Every runtime spawns through `spawnRuntimeProcess`. With `settings.sandbox`
// set, the command runs in a kubernetes-sigs/agent-sandbox pod via sandbox.sh
// instead of on the host; stdout is the CLI's own stream either way.
// https://github.com/kubernetes-sigs/agent-sandbox

import { join } from "path";
import { getSettings } from "../config";
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
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
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
  const { sandbox, timeouts } = getSettings();
  if (!sandbox) {
    return Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, ...(cwd ? { cwd } : {}) });
  }
  // The spawn site doesn't know its timeout category, so outlive the longest one.
  const lifetimeMs = Math.max(timeouts.telegram, timeouts.heartbeat, timeouts.job, timeouts.default) * 60_000 + CLEANUP_GRACE_MS;
  const wrapped = sandboxCommand(argv, env, sandbox, lifetimeMs, cwd);
  return Bun.spawn(wrapped.argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: wrapped.env });
}

/** Host argv/env that run `args` in a freshly claimed pod. `lifetimeMs` backs
 *  up the script's trap: the controller deletes the claim if the daemon dies. */
export function sandboxCommand(
  args: string[],
  env: Record<string, string>,
  cfg: SandboxConfig,
  lifetimeMs: number,
  cwd = "",
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
  for (const [k, v] of Object.entries(env)) {
    if (!FORWARDED_ENV.test(k)) continue;
    if (v.includes("\n")) {
      console.warn(`[sandbox] not forwarding ${k}: multi-line values can't cross exec stdin`);
      continue;
    }
    forwarded.push(`${k}=${v}`);
  }
  return {
    // The host's absolute CLI path means nothing in the pod; use its basename.
    argv: ["sh", SCRIPT, exe.split("/").pop() ?? exe, ...rest],
    env: {
      ...env,
      ERRANDD_SB_NAMESPACE: cfg.namespace,
      ERRANDD_SB_CONTEXT: cfg.context ?? "",
      ERRANDD_SB_CLAIM: JSON.stringify(claim),
      ERRANDD_SB_ENV: forwarded.join("\n"),
      ERRANDD_SB_CWD: cwd,
    },
  };
}
