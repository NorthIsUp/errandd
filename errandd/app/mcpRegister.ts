/**
 * Register the configured MCP servers in USER scope at boot.
 *
 * The daemon spawns `claude -p` from $HOME and never loads a repo's
 * project-scope `.mcp.json`, so any MCP server the routines call has to be
 * registered in user scope. That list used to live only in the deployment's
 * start-errandd.sh; it moves here so the daemon owns it and the image doesn't
 * need a bespoke boot script.
 *
 * Registration is remove-then-add so a rotated token or changed URL is always
 * reflected. Two lessons from the shell version are baked in:
 *
 *  - **"already exists" is success.** The script's `add` ran with `set -e`
 *    after a silenced `remove`; when the volume filled, the remove failed to
 *    write, `add` reported "already exists in user config", exited 1, and took
 *    the whole boot down for 23 hours. A server that's already registered is
 *    the desired end state, not an error.
 *  - **One server's failure must not stop the rest.** Each is independent.
 */

import type { McpServerSpec } from "./config";
import { addMcpServer, removeMcpServer } from "./mcp";

/**
 * Resolve the server list: `ERRANDD_MCP_SERVERS` (a JSON array) wins over
 * `settings.mcpServers`.
 *
 * The env form exists so a GitOps deployment can declare its servers in the
 * manifest next to the secrets they reference, instead of hand-editing a
 * settings.json that lives on a persistent volume outside version control.
 * Malformed JSON falls back to settings rather than taking the daemon down.
 */
export function resolveMcpServers(
  settings: McpServerSpec[] | undefined,
  env: Record<string, string | undefined> = process.env,
): McpServerSpec[] {
  const raw = env.ERRANDD_MCP_SERVERS?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (s): s is McpServerSpec =>
            typeof s === "object" &&
            s !== null &&
            typeof (s as McpServerSpec).name === "string" &&
            typeof (s as McpServerSpec).target === "string",
        );
      }
    } catch {
      // fall through to settings
    }
  }
  return settings ?? [];
}

/** True when `name` resolves to an executable on PATH. */
export async function commandExists(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["sh", "-c", `command -v ${JSON.stringify(name)}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Which specs are registerable right now. Pure, so the gating rules are
 * testable without a CLI: an explicit `enabled: false`, a missing required env
 * var, or an absent command each skip the server rather than fail the boot.
 */
export function selectRegisterable(
  specs: McpServerSpec[],
  env: Record<string, string | undefined>,
  commandPresent: (name: string) => boolean,
): { register: McpServerSpec[]; skipped: { name: string; reason: string }[] } {
  const register: McpServerSpec[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const spec of specs) {
    if (spec.enabled === false) {
      skipped.push({ name: spec.name, reason: "disabled" });
      continue;
    }
    const missing = (spec.requireEnv ?? []).filter((k) => !env[k]?.trim());
    if (missing.length > 0) {
      skipped.push({ name: spec.name, reason: `missing env ${missing.join(", ")}` });
      continue;
    }
    if (spec.requireCommand && !commandPresent(spec.requireCommand)) {
      skipped.push({ name: spec.name, reason: `${spec.requireCommand} not on PATH` });
      continue;
    }
    register.push(spec);
  }
  return { register, skipped };
}

/** "already registered" is the end state we wanted, not a failure. */
function isAlreadyExists(err: unknown): boolean {
  return /already exists/i.test(String(err));
}

/**
 * Register every eligible server. Never throws; returns a one-line summary.
 */
export async function registerMcpServers(
  settingsSpecs: McpServerSpec[] | undefined,
  log: (msg: string) => void = (m) => console.log(m),
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const specs = resolveMcpServers(settingsSpecs, env);
  if (specs.length === 0) {
    return "";
  }

  // Resolve command availability once, up front, so the pure selector stays sync.
  const needed = [...new Set(specs.map((s) => s.requireCommand).filter((c): c is string => !!c))];
  const present = new Set<string>();
  for (const cmd of needed) {
    if (await commandExists(cmd)) {
      present.add(cmd);
    }
  }

  const { register, skipped } = selectRegisterable(specs, env, (c) => present.has(c));
  for (const s of skipped) {
    log(`mcp: skipped ${s.name} — ${s.reason}`);
  }

  let ok = 0;
  for (const spec of register) {
    try {
      // Remove first so a changed URL/header/command actually takes effect.
      await removeMcpServer(spec.name, "user").catch(() => {});
      await addMcpServer({
        name: spec.name,
        scope: "user",
        transport: spec.transport,
        target: spec.target,
        ...(spec.headers ? { headers: spec.headers } : {}),
      });
      ok += 1;
    } catch (err) {
      if (isAlreadyExists(err)) {
        ok += 1;
        continue;
      }
      log(`mcp: failed to register ${spec.name} — ${String(err)}`);
    }
  }

  return ok > 0 ? `registered ${ok}/${register.length} MCP server(s)` : "";
}
