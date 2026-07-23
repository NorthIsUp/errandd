// Env / path / security / model arg building for spawning the `claude` CLI.
// Extracted verbatim from runner.ts — behavior-preserving.

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getSettings, type ModelConfig, type SecurityConfig } from "./config";

const PERMISSION_MODE_FILE = join(process.cwd(), ".claude/errandd/permission-mode.json");

/**
 * On Windows, `claude` resolves to `claude.cmd`, a batch wrapper that must
 * be run through cmd.exe (8191-char command-line limit). Resolving the
 * underlying `claude.exe` lets us call it directly via CreateProcessW
 * (32767-char limit). Required because --append-system-prompt + prompt
 * files + CLAUDE.md can easily exceed 8K.
 */
export function resolveClaudeExecutable(): string {
  if (process.platform !== "win32") return "claude";
  try {
    const out = execSync("where claude", { encoding: "utf8" });
    const cmdPath = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.toLowerCase().endsWith(".cmd"));
    if (!cmdPath) return "claude";
    const exePath = join(
      dirname(cmdPath),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    return existsSync(exePath) ? exePath : "claude";
  } catch {
    return "claude";
  }
}

export const CLAUDE_EXECUTABLE = resolveClaudeExecutable();

/**
 * Build a sanitized env for spawning the `claude` CLI as a long-running daemon
 * subprocess. Drops env vars injected by a parent Claude Code / Claude Desktop
 * session that break detached child auth:
 *
 * - `CLAUDECODE`: marks "we're nested inside Claude Code" — confuses the CLI's
 *   reentry detection and triggers transcript-aware behaviour we don't want.
 * - `CLAUDE_CODE_OAUTH_TOKEN`: the parent's frozen OAuth access token. Without
 *   the matching refresh token (which lives in the platform-native credential
 *   store, not the env), it expires after ~8h and the daemon's spawned `claude`
 *   processes start returning HTTP 401 silently. Stripping it lets the CLI
 *   fall back to the credential store on each platform — Keychain on macOS,
 *   `~/.claude/.credentials.json` on Linux/WSL2, Credential Manager on Windows
 *   — which handles refresh automatically.
 * - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`: tells the CLI "the host process
 *   manages provider auth — don't read local credentials." In a detached
 *   daemon there is no host to consult; the CLI errors with `Not logged in`.
 *
 * Cross-platform note: the helper just deletes keys from the inherited env
 * object — no shell, no OS-specific calls. The `claude` CLI it spawns then
 * resolves credentials using its own per-platform code path.
 */
export function cleanSpawnEnv(): Record<string, string> {
  const stripped = new Set([
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (stripped.has(key)) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

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

  // Output style — claude-only (other runtimes have no equivalent). Merged in
  // as inline extra settings so it rides along on every claude spawn site.
  // Read defensively: getSettings() throws before loadSettings() (e.g. in
  // argv-contract unit tests that build args without a loaded config) — in
  // that case there's no style to apply, which is the correct default.
  try {
    const settings = getSettings();
    if (settings.runtime === "claude") {
      args.push(...outputStyleArgs(settings.outputStyle));
    }
  } catch {
    // settings not loaded — no output style
  }

  return args;
}

/** `--settings {"outputStyle":…}` when a style is set, else nothing. `--settings`
 *  takes a JSON string; claude merges it over the on-disk settings. Empty /
 *  whitespace-only means "inherit the CLI default". */
export function outputStyleArgs(outputStyle: string | undefined): string[] {
  const trimmed = outputStyle?.trim();
  return trimmed ? ["--settings", JSON.stringify({ outputStyle: trimmed })] : [];
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
