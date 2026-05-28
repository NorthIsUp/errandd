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

async function runCli(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["claude", ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
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
export async function listMarketplaces(): Promise<Marketplace[]> {
  const r = await runCli(["plugin", "marketplace", "list", "--json"]);
  if (!r.ok) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? (parsed as Marketplace[]) : [];
  } catch {
    return [];
  }
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
export async function listPlugins(): Promise<{
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
}> {
  const r = await runCli(["plugin", "list", "--json", "--available"]);
  if (!r.ok) return { installed: [], available: [] };
  try {
    const parsed = JSON.parse(r.stdout) as {
      installed?: unknown;
      available?: unknown;
    };
    return {
      installed: Array.isArray(parsed.installed) ? (parsed.installed as InstalledPlugin[]) : [],
      available: Array.isArray(parsed.available) ? (parsed.available as AvailablePlugin[]) : [],
    };
  } catch {
    return { installed: [], available: [] };
  }
}

export async function installPlugin(id: string): Promise<CliResult> {
  return (
    rejectFlagLike(id) ??
    asCliResult(await runCli(["plugin", "install", "--", id]))
  );
}

/** Return true if `id` refers to the clawdcode plugin itself (any
 *  marketplace it might have been installed from). Removing the plugin we
 *  are currently running is a footgun — the daemon would either keep
 *  running until restart and then fail to boot, or terminate mid-request. */
function isSelfPluginId(id: string): boolean {
  const [name] = id.split("@", 1);
  return name === "clawdcode";
}

export async function uninstallPlugin(id: string): Promise<CliResult> {
  // --keep-data preserves persistent data dir so re-installs don't lose
  // state. The `--` separator goes after our flags but before the user
  // value so the value can't smuggle additional flags.
  if (isSelfPluginId(id)) {
    return { ok: false, output: "", error: "clawdcode cannot uninstall itself" };
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

export async function enablePlugin(id: string): Promise<CliResult> {
  return (
    rejectFlagLike(id) ??
    asCliResult(await runCli(["plugin", "enable", "--", id]))
  );
}

export async function disablePlugin(id: string): Promise<CliResult> {
  return (
    rejectFlagLike(id) ??
    asCliResult(await runCli(["plugin", "disable", "--", id]))
  );
}

/** Update every installed plugin. Sequential rather than parallel so a
 *  flaky network for one plugin doesn't stall the rest behind a single
 *  outstanding HTTP. */
export async function updateAllPlugins(): Promise<{
  results: Array<{ id: string; result: CliResult }>;
}> {
  const { installed } = await listPlugins();
  const results: Array<{ id: string; result: CliResult }> = [];
  for (const p of installed) {
    results.push({ id: p.id, result: await updatePlugin(p.id) });
  }
  return { results };
}
