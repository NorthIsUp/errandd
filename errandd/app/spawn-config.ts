// Env / path / security / model arg building for spawning the `claude` CLI.
// Extracted verbatim from runner.ts — behavior-preserving.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getSettings, type ModelConfig, type SecurityConfig } from "./config";

const PERMISSION_MODE_FILE = join(process.cwd(), ".claude/errandd/permission-mode.json");

export { CLAUDE_EXECUTABLE, cleanSpawnEnv } from "./claudeExe";

export function buildChildEnv(baseEnv: Record<string, string>, model: string, api: string): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv };
  const normalizedModel = model.trim().toLowerCase();

  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();

  if (normalizedModel === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  return childEnv;
}

export function sameModelConfig(a: ModelConfig, b: ModelConfig): boolean {
  return a.model.trim().toLowerCase() === b.model.trim().toLowerCase() && a.api.trim() === b.api.trim();
}

export function hasModelConfig(value: ModelConfig): boolean {
  return value.model.trim().length > 0 || value.api.trim().length > 0;
}

/**
 * Resolve the subprocess timeout (in ms) for a given invocation category.
 * Values are read fresh from settings on every call, so hot-reload works
 * automatically: edit settings.json and the next subprocess picks it up.
 *
 * Category mapping:
 *   "telegram"  → settings.timeouts.telegram  (default 5 min)
 *   "heartbeat" → settings.timeouts.heartbeat (default 15 min)
 *   "job"       → settings.timeouts.job       (default 30 min)
 *   anything else (bootstrap, trigger, chat…) → settings.timeouts.default (default 5 min)
 *
 * Use execClaude's `timeoutCategory` param to pass the category separately from
 * the display/log/session name (e.g. scheduled jobs use job.name for the session
 * ID but pass "job" as the category so they get timeouts.job, not timeouts.default).
 */
export function resolveTimeoutMs(name: string): number {
  const t = getSettings().timeouts;
  let minutes: number;
  if (name === "telegram") {
    minutes = t.telegram;
  } else if (name === "heartbeat") {
    minutes = t.heartbeat;
  } else if (name === "job") {
    minutes = t.job;
  } else {
    minutes = t.default;
  }
  return minutes * 60_000;
}

export type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";

let cachedPermissionMode: PermissionMode | null = null;

export function getPermissionMode(): PermissionMode {
  if (cachedPermissionMode) return cachedPermissionMode;
  try {
    const raw = JSON.parse(readFileSync(PERMISSION_MODE_FILE, "utf8")) as { mode?: unknown };
    if (raw.mode === "plan" || raw.mode === "acceptEdits" || raw.mode === "bypassPermissions") {
      cachedPermissionMode = raw.mode;
      return raw.mode;
    }
  } catch {}
  return "bypassPermissions";
}

export function setPermissionMode(mode: PermissionMode): void {
  cachedPermissionMode = mode;
  try {
    mkdirSync(dirname(PERMISSION_MODE_FILE), { recursive: true });
    writeFileSync(PERMISSION_MODE_FILE, `${JSON.stringify({ mode }, null, 2)}\n`);
  } catch (err) {
    console.error("[runner] Failed to persist permission mode:", err);
  }
}

export function buildSecurityArgs(security: SecurityConfig): string[] {
  const permissionMode = getPermissionMode();
  const args: string[] = permissionMode === "bypassPermissions"
    ? ["--dangerously-skip-permissions"]
    : ["--permission-mode", permissionMode];

  switch (security.level) {
    case "locked":
      args.push("--tools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
      // all tools available, scoped to project dir via system prompt
      break;
    case "unrestricted":
      // all tools, no directory restriction
      break;
  }

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(" "));
  }
  if (security.disallowedTools.length > 0) {
    args.push("--disallowedTools", security.disallowedTools.join(" "));
  }

  return args;
}

/** Strip --resume <id> from a claude argv list so it runs as a brand-new session. */
export function stripResume(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") {
      i += 1; // skip the session id that follows
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/** Replace the value following --output-format (returns a modified copy). */
export function withOutputFormat(args: string[], format: string): string[] {
  const out = [...args];
  const idx = out.indexOf("--output-format");
  if (idx >= 0 && idx + 1 < out.length) out[idx + 1] = format;
  return out;
}
