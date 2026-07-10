/**
 * MCP server management — wraps the `claude mcp` CLI.
 *
 * Findings from `claude mcp --help` (Step 0):
 *  - `claude mcp list`  has NO --scope and NO --json flags; output is text.
 *    Format per line: `<name>: <target> [(HTTP|SSE)] - <status>`
 *    stdio servers omit the transport parenthetical.
 *  - `claude mcp add` uses `-s/--scope` (user/project/local, default local).
 *    stdio:  claude mcp add [-s <scope>] <name> [--] <command> [args...]
 *    http:   claude mcp add [-s <scope>] --transport http <name> <url> [-H "K: V"]
 *    sse:    claude mcp add [-s <scope>] --transport sse  <name> <url> [-H "K: V"]
 *  - `claude mcp remove` uses `-s/--scope`; if omitted it auto-detects.
 *  - `claude mcp get <name>` shows scope and type per server.
 *
 * We parse `mcp list` text output and, when scope info is needed, call
 * `mcp get` once per server (acceptable because the list is typically short).
 */

import { join } from "path";
import { execSync } from "child_process";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Resolve the claude executable (mirrors haiku.ts)
// ---------------------------------------------------------------------------

function resolveClaudeExecutable(): string {
  if (process.platform !== "win32") return "claude";
  try {
    const out = execSync("where claude", { encoding: "utf8" });
    const cmdPath = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.toLowerCase().endsWith(".cmd"));
    if (!cmdPath) return "claude";
    const exePath = join(
      import.meta.dir,
      "..",
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

const CLAUDE_EXECUTABLE = resolveClaudeExecutable();

function cleanSpawnEnv(): Record<string, string> {
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

const MCP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpServer {
  name: string;
  scope: "user" | "project" | "local";
  transport: "stdio" | "http" | "sse";
  /** For stdio: the command + args string. For http/sse: the URL. */
  target: string;
  /** Optional raw "Name: Value" header strings (http/sse only). */
  headers?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn `claude mcp ...` and return { stdout, stderr, exitCode }. */
async function spawnMcp(
  args: string[],
  timeoutMs = MCP_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([CLAUDE_EXECUTABLE, "mcp", ...args], {
    env: cleanSpawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`claude mcp timed out after ${timeoutMs}ms`));
    }, timeoutMs)
  );

  const [stdout, stderr, exitCode] = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]),
    timer,
  ]);

  return { stdout, stderr, exitCode };
}

/**
 * Parse `claude mcp list` text output.
 *
 * Output format (one server per line after the "Checking…" header):
 *   <name>: <command>  - <status>            ← stdio
 *   <name>: <url> (HTTP) - <status>          ← http
 *   <name>: <url> (SSE)  - <status>          ← sse
 *
 * We infer transport from whether the target looks like a URL and whether
 * the line contains "(HTTP)" or "(SSE)".
 */
function parseMcpListOutput(text: string): { name: string; transport: "stdio" | "http" | "sse"; target: string }[] {
  const results: { name: string; transport: "stdio" | "http" | "sse"; target: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("Checking")) continue;
    // Pattern: "<name>: <rest> - <status>"
    // Name can contain colons (e.g. "plugin:foo:bar")
    // We split on ": " (colon-space) to find the name boundary.
    const colonSpaceIdx = line.indexOf(": ");
    if (colonSpaceIdx === -1) continue;
    const name = line.slice(0, colonSpaceIdx).trim();
    let rest = line.slice(colonSpaceIdx + 2).trim();
    // Strip trailing " - <status>" (last " - " occurrence)
    const dashStatusIdx = rest.lastIndexOf(" - ");
    if (dashStatusIdx !== -1) rest = rest.slice(0, dashStatusIdx).trim();
    // Detect transport
    let transport: "stdio" | "http" | "sse" = "stdio";
    let target = rest;
    if (rest.endsWith("(HTTP)")) {
      transport = "http";
      target = rest.slice(0, rest.length - "(HTTP)".length).trim();
    } else if (rest.endsWith("(SSE)")) {
      transport = "sse";
      target = rest.slice(0, rest.length - "(SSE)".length).trim();
    } else if (/^https?:\/\//i.test(rest)) {
      transport = "http";
      target = rest;
    }
    if (name) results.push({ name, transport, target });
  }
  return results;
}

/**
 * Call `claude mcp get <name>` and parse the scope out of the output.
 * Returns "user" / "project" / "local" (defaults to "local" on error).
 */
async function getServerScope(name: string): Promise<"user" | "project" | "local"> {
  try {
    const { stdout } = await spawnMcp(["get", name]);
    // "Scope: User config …" → user
    // "Scope: Project …"    → project
    // "Scope: Local …"      → local
    if (/scope:\s*user/i.test(stdout)) return "user";
    if (/scope:\s*project/i.test(stdout)) return "project";
    return "local";
  } catch {
    return "local";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;

/**
 * Split a stdio command string into argv, respecting single/double quotes so
 * an arg with spaces (e.g. `--flag "a b"` or a quoted path) survives as one
 * token. A naive `split(/\s+/)` would shatter quoted args; this walks the
 * string char-by-char, tracking the active quote char, and emits a token at
 * each run of unquoted whitespace. Backslash escaping is intentionally not
 * supported — these targets are shell-free argv passed straight to spawn.
 */
function splitCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false; // distinguishes an empty quoted token "" from no token
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * List MCP servers.  When `scope` is provided, only servers matching that
 * scope are returned (determined via individual `get` calls).  If `scope` is
 * omitted all servers are returned.
 */
export async function listMcpServers(scope?: "user" | "project" | "local"): Promise<McpServer[]> {
  const { stdout } = await spawnMcp(["list"]);
  const parsed = parseMcpListOutput(stdout);
  if (!parsed.length) return [];

  // Resolve scope for each server in parallel (N `get` calls, typically ≤ 10)
  const withScope = await Promise.all(
    parsed.map(async (s) => {
      const resolvedScope = await getServerScope(s.name);
      return { ...s, scope: resolvedScope };
    })
  );

  if (!scope) return withScope;
  return withScope.filter((s) => s.scope === scope);
}

/** Validate a server name. Throws a descriptive error on failure. */
function validateServer(server: McpServer): void {
  if (!NAME_RE.test(server.name)) {
    throw new Error(
      `Invalid MCP server name "${server.name}". Must match ${NAME_RE}.`
    );
  }
  if (!server.target?.trim()) {
    throw new Error("MCP server target must not be empty.");
  }
}

/**
 * Add an MCP server via `claude mcp add`.
 *
 * stdio:  claude mcp add -s <scope> <name> [--] <cmd> [args...]
 * http:   claude mcp add -s <scope> --transport http <name> <url> [-H "K: V"]
 * sse:    claude mcp add -s <scope> --transport sse  <name> <url> [-H "K: V"]
 */
export async function addMcpServer(server: McpServer): Promise<void> {
  validateServer(server);

  const scope = server.scope ?? "user";
  const argv: string[] = ["add", "-s", scope];

  if (server.transport === "http" || server.transport === "sse") {
    argv.push("--transport", server.transport);
    argv.push(server.name);
    argv.push(server.target.trim());
    for (const h of server.headers ?? []) {
      argv.push("-H", h);
    }
  } else {
    // stdio — split target into command + args (quote-aware so an arg with
    // spaces isn't shattered into separate tokens).
    const parts = splitCommandArgs(server.target.trim()).filter(Boolean);
    if (!parts.length) throw new Error("stdio target must include at least a command.");
    argv.push(server.name);
    argv.push(...parts);
  }

  const { stdout, stderr, exitCode } = await spawnMcp(argv);
  if (exitCode !== 0) {
    throw new Error(
      `claude mcp add exited ${exitCode}: ${(stderr || stdout).trim()}`
    );
  }
}

/**
 * Remove an MCP server.  Treats "not found" as success (idempotent).
 */
export async function removeMcpServer(
  name: string,
  scope: "user" | "project" | "local" = "user"
): Promise<void> {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid MCP server name "${name}". Must match ${NAME_RE}.`);
  }
  const argv: string[] = ["remove", "-s", scope, name];
  const { stdout, stderr, exitCode } = await spawnMcp(argv);
  if (exitCode !== 0) {
    const msg = (stderr || stdout).trim().toLowerCase();
    // Treat "not found" as success
    if (msg.includes("not found") || msg.includes("no mcp server")) return;
    throw new Error(
      `claude mcp remove exited ${exitCode}: ${(stderr || stdout).trim()}`
    );
  }
}
