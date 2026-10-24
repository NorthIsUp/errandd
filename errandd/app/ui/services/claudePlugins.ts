/**
 * Thin wrappers around the `claude plugin` CLI. The daemon shells out
 * rather than re-implementing the marketplace/install state machine, so
 * we always see the same view of the world that the user gets from the
 * `claude` CLI directly.
 *
 * All functions return `{ ok, output?, error? }` instead of throwing.
 * UI surfaces errors as toasts; we don't want one bad CLI call to take
 * down a settings page.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ENABLED } from "../../preflight";
import { cachedRead, getReadCache, refreshCachedRead } from "../../readCache";

export interface Marketplace {
  name: string;
  source: string;
  repo?: string;
  url?: string;
  path?: string;
  installLocation: string;
}

export interface InstalledPlugin {
  id: string; // "<plugin>@<marketplace>"
  version: string;
  scope: "user" | "project" | "local" | "managed";
  enabled: boolean;
  installPath: string;
  installedAt?: string;
  lastUpdated?: string;
  projectPath?: string;
  /** Skill / command / agent names the plugin ships, enumerated from its
   *  installPath. Used by the dashboard to render the plugin as a tree.
   *  Empty/omitted when the path isn't scannable (e.g. the synthetic self
   *  row). Claude Code has NO native per-skill enable/disable, so these are
   *  display-only — the whole plugin is governed by `enabled`. */
  skills?: string[];
  commands?: string[];
  agents?: string[];
  /** True when the plugin's GitOps default is ENABLED — i.e. its
   *  `<plugin>@<marketplace>` key is in preflight's DEFAULT_ENABLED allowlist
   *  (the single source of truth). Drives the `●` marker in the dashboard:
   *  for a plugin the user hasn't locally overridden, `●` present ⟺ toggle ON.
   *  Installed-but-default-disabled plugins are `false`. */
  gitopsDefaultEnabled: boolean;
  /** True when the EFFECTIVE enabled state (`enabled`, i.e. the local override
   *  merged over the project default) DIFFERS from `gitopsDefaultEnabled` — the
   *  user has deliberately overridden the GitOps default for their sessions.
   *  Drives the subtle "overridden" drift marker. */
  overridden: boolean;
}

export interface AvailablePlugin {
  pluginId: string; // "<plugin>@<marketplace>"
  name: string;
  description?: string;
  marketplaceName: string;
  installCount?: number;
  category?: string;
  tags?: string[];
}

export interface CliResult {
  ok: boolean;
  output: string;
  error: string | null;
}

/** Enumerate the skill / command / agent names a plugin ships, by scanning
 *  its installPath. Skills are directories under `skills/` (each holding a
 *  SKILL.md); commands and agents are `*.md` files under `commands/` /
 *  `agents/`. Missing dirs → empty arrays. Never throws — a bad path just
 *  yields no children. Synchronous readdir keeps listPlugins a single await. */
function enumeratePluginChildren(installPath: string): {
  skills: string[];
  commands: string[];
  agents: string[];
} {
  const dirNames = (sub: string): string[] => {
    try {
      return readdirSync(join(installPath, sub), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };
  const mdNames = (sub: string): string[] => {
    try {
      return readdirSync(join(installPath, sub), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name.replace(/\.md$/, ""))
        .sort();
    } catch {
      return [];
    }
  };
  return { skills: dirNames("skills"), commands: mdNames("commands"), agents: mdNames("agents") };
}

async function runCli(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["claude", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    const result = { ok: code === 0, stdout, stderr };
    if (args[0] === "plugin" && !args.includes("list")) {
      const store = getReadCache();
      store.db.run("INSERT INTO plugin_operations(operation,target,ok,finished_at,error) VALUES(?,?,?,?,?)",
        [args.filter(arg => !arg.startsWith("-")).slice(0, 3).join(" "), args.at(-1) ?? null,
         Number(result.ok), Date.now(), result.ok ? null : stderr]);
      store.db.run("DELETE FROM plugin_operations WHERE id NOT IN (SELECT id FROM plugin_operations ORDER BY id DESC LIMIT 1000)");
      if (result.ok) await refreshPluginSnapshots();
    }
    return result;
  } catch (e) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** Reject anything that looks like a CLI flag before it reaches argv —
 *  even argv-only spawning is vulnerable to "flag smuggling" if a value
 *  starts with `-` (e.g. `--scope managed` or `--help`). Combined with
 *  the `--` separator in each callsite below, this gives defense in depth
 *  against argv injection from HTTP-supplied values. */
function rejectFlagLike(value: string): CliResult | null {
  if (!value || value.startsWith("-")) {
    return { ok: false, output: "", error: "invalid value (must not start with '-')" };
  }
  return null;
}

function asCliResult(r: { ok: boolean; stdout: string; stderr: string }): CliResult {
  return {
    ok: r.ok,
    output: (r.stdout + r.stderr).trim(),
    error: r.ok ? null : r.stderr.trim() || "claude plugin command failed",
  };
}

/** List configured marketplaces. */
async function readMarketplaces(): Promise<Marketplace[]> {
  const r = await runCli(["plugin", "marketplace", "list", "--json"]);
  if (!r.ok) throw new Error(r.stderr || "Cannot list plugin marketplaces");
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) throw new Error("Invalid marketplace list");
    return parsed as Marketplace[];
  } catch (error) { throw new Error("Cannot parse marketplace list", { cause: error }); }
}

/** Add a marketplace by URL / path / GitHub repo ref. */
export async function addMarketplace(ref: string): Promise<CliResult> {
  return (
    rejectFlagLike(ref) ??
    asCliResult(await runCli(["plugin", "marketplace", "add", "--", ref]))
  );
}

/** Remove a configured marketplace by name. */
export async function removeMarketplace(name: string): Promise<CliResult> {
  return (
    rejectFlagLike(name) ??
    asCliResult(await runCli(["plugin", "marketplace", "remove", "--", name]))
  );
}

/** Refresh a single marketplace, or all when name is omitted. */
export async function updateMarketplace(name?: string): Promise<CliResult> {
  if (!name) {
    return asCliResult(await runCli(["plugin", "marketplace", "update"]));
  }
  return (
    rejectFlagLike(name) ??
    asCliResult(await runCli(["plugin", "marketplace", "update", "--", name]))
  );
}

/** List installed + available plugins. */
async function readPlugins(): Promise<{
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
}> {
  const r = await runCli(["plugin", "list", "--json", "--available"]);
  if (!r.ok) throw new Error(r.stderr || "Cannot list plugins");
  try {
    const parsed = JSON.parse(r.stdout) as {
      installed?: unknown;
      available?: unknown;
    };
    if (!Array.isArray(parsed.installed)) throw new Error("Invalid installed plugin list");
    const installed = Array.isArray(parsed.installed)
      ? (parsed.installed as InstalledPlugin[]).map((p) => {
          const gitopsDefaultEnabled = DEFAULT_ENABLED.has(p.id);
          return {
            ...p,
            ...(p.installPath ? enumeratePluginChildren(p.installPath) : {}),
            gitopsDefaultEnabled,
            overridden: p.enabled !== gitopsDefaultEnabled,
          };
        })
      : [];
    const db = getReadCache().db;
    db.transaction(() => {
      db.run("DELETE FROM plugin_state");
      for (const plugin of installed) db.run(
        "INSERT OR REPLACE INTO plugin_state(id,scope,project_path,enabled,version,last_updated) VALUES(?,?,?,?,?,?)",
        [plugin.id, plugin.scope, plugin.projectPath ?? "", Number(plugin.enabled), plugin.version, plugin.lastUpdated ?? null]);
    })();
    return {
      installed,
      available: Array.isArray(parsed.available) ? (parsed.available as AvailablePlugin[]) : [],
    };
  } catch (error) { throw new Error("Cannot parse plugin list", { cause: error }); }
}

export async function installPlugin(id: string): Promise<CliResult> {
  return (
    rejectFlagLike(id) ??
    asCliResult(await runCli(["plugin", "install", "--", id]))
  );
}

/** Return true if `id` refers to the errandd plugin itself (any
 *  marketplace it might have been installed from). Removing the plugin we
 *  are currently running is a footgun — the daemon would either keep
 *  running until restart and then fail to boot, or terminate mid-request. */
function isSelfPluginId(id: string): boolean {
  const [name] = id.split("@", 1);
  return name === "errandd";
}

export async function uninstallPlugin(id: string): Promise<CliResult> {
  // --keep-data preserves persistent data dir so re-installs don't lose
  // state. The `--` separator goes after our flags but before the user
  // value so the value can't smuggle additional flags.
  if (isSelfPluginId(id)) {
    return { ok: false, output: "", error: "errandd cannot uninstall itself" };
  }
  return (
    rejectFlagLike(id) ??
    asCliResult(await runCli(["plugin", "uninstall", "--keep-data", "--", id]))
  );
}

export async function updatePlugin(id: string): Promise<CliResult> {
  return (
    rejectFlagLike(id) ??
    asCliResult(await runCli(["plugin", "update", "--", id]))
  );
}

// Enable/disable operate at LOCAL scope (project `.claude/settings.local.json`).
// The default suite is gitops-provisioned into the PROJECT scope
// (`.claude/settings.json`, shared with the team — see app/preflight.ts). A
// plain enable/disable auto-detects that project scope and refuses to touch a
// team-shared default. Writing a per-user LOCAL override instead lets the user
// toggle a managed default for their own spawned sessions while leaving the
// gitops default untouched. Claude Code merges user < project < local, so the
// local choice wins; `listPlugins` (claude plugin list --json) then reports the
// merged effective `enabled`, which is what the toggle's checked-state reads.
export async function enablePlugin(id: string): Promise<CliResult> {
  return (
    rejectFlagLike(id) ??
    asCliResult(await runCli(["plugin", "enable", "--scope", "local", "--", id]))
  );
}

export async function disablePlugin(id: string): Promise<CliResult> {
  return (
    rejectFlagLike(id) ??
    asCliResult(await runCli(["plugin", "disable", "--scope", "local", "--", id]))
  );
}

/** Update every installed plugin. Sequential rather than parallel so a
 *  flaky network for one plugin doesn't stall the rest behind a single
 *  outstanding HTTP. */
export async function updateAllPlugins(): Promise<{
  results: { id: string; result: CliResult }[];
}> {
  const { installed } = await listPlugins();
  const results: { id: string; result: CliResult }[] = [];
  for (const p of installed) {
    results.push({ id: p.id, result: await updatePlugin(p.id) });
  }
  return { results };
}

/** The settings page reads SQL; CLI discovery happens on refresh/mutation. */
export async function listPlugins() {
  const plugins = await cachedRead("plugins", "installed-and-available", 30_000, readPlugins);
  const db = getReadCache().db;
  const counts = db.query<{ enabled: number; disabled: number }, []>(
    "SELECT coalesce(sum(enabled=1),0) AS enabled,coalesce(sum(enabled=0),0) AS disabled FROM plugin_state").get()!;
  const updates = db.query<{ succeeded: number; failed: number; lastUpdateAt: number | null }, []>(
    "SELECT coalesce(sum(ok=1),0) AS succeeded, coalesce(sum(ok=0),0) AS failed, max(finished_at) AS lastUpdateAt FROM plugin_operations WHERE operation LIKE 'plugin update%'").get()!;
  return { ...plugins, stats: { ...counts, updates } };
}
export async function listMarketplaces(): Promise<Marketplace[]> {
  return cachedRead("plugins", "marketplaces", 30_000, readMarketplaces);
}
export async function refreshPluginSnapshots(): Promise<void> {
  await Promise.allSettled([
    refreshCachedRead("plugins", "installed-and-available", readPlugins),
    refreshCachedRead("plugins", "marketplaces", readMarketplaces),
  ]);
}
