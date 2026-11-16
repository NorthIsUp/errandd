// What a sandboxed job needs that a fresh pod lacks: the daemon's GitHub auth,
// its http MCP servers, and its enabled Claude plugins. The daemon stays the
// single source of truth; sandbox.sh ships this into the pod per job.

import { existsSync, readFileSync } from "fs";
import { basename, join, relative } from "path";
import { asRecord, JOBS_REPOS_PARENT_DIR, type McpServerSpec } from "../config";

export interface SandboxKit {
  /** Forwarded over exec stdin as-is (bypasses the generic env allowlist). */
  env: Record<string, string>;
  /** Inserted right after the executable. */
  args: string[];
  /** Flags removed from the command line, each with the value that follows it. */
  dropFlags: string[];
  /** Files under `claudeDir` to stream into the pod's ~/.claude. */
  paths: string[];
  /** Written to the pod's ~/.claude/plugins/known_marketplaces.json ("" = skip). */
  knownMarketplaces: string;
  claudeDir: string;
}

export const EMPTY_KIT: SandboxKit = { env: {}, args: [], dropFlags: [], paths: [], knownMarketplaces: "", claudeDir: "" };

export function buildSandboxKit(
  exe: string,
  mcpServers: McpServerSpec[],
  env: Record<string, string>,
  claudeDir: string,
  ghToken: string | null,
  forwardEnv: string[] = [],
): SandboxKit {
  const kit: SandboxKit = { env: {}, args: [], dropFlags: [], paths: [], knownMarketplaces: "", claudeDir };
  for (const k of forwardEnv) if (env[k]) kit.env[k] = env[k];
  if (ghToken) {
    // git has no GH_TOKEN support; route github.com credentials through gh via env-only config.
    Object.assign(kit.env, {
      GH_TOKEN: ghToken,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "!gh auth git-credential",
    });
  }
  // --mcp-config and plugins are Claude Code features; other runtimes get auth only.
  if (basename(exe) !== "claude") return kit;

  // Each job gets a fresh pod with no session store, so a resume can only fail.
  kit.dropFlags = ["--resume"];

  const servers: Record<string, unknown> = {};
  for (const s of mcpServers) {
    if (s.enabled === false) continue;
    const required = s.requireEnv ?? [];
    if (!required.every((k) => env[k]?.trim())) continue;
    for (const k of required) kit.env[k] = env[k] ?? "";
    const headers = Object.fromEntries(
      (s.headers ?? []).map((h) => {
        const i = h.indexOf(":");
        return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
      }),
    );
    // Job pods run the daemon's image, so a stdio server's command exists there too;
    // `sh -c` keeps the target's own quoting. Header values keep their ${VAR}
    // placeholders, which the CLI expands from the forwarded env.
    servers[s.name] =
      s.transport === "stdio"
        ? { type: "stdio", command: "sh", args: ["-c", s.target] }
        : { type: s.transport, url: s.target, headers };
  }
  if (Object.keys(servers).length) kit.args = ["--mcp-config", JSON.stringify({ mcpServers: servers })];

  const plugins = pluginKit(claudeDir);
  kit.paths = plugins.paths;
  kit.knownMarketplaces = plugins.knownMarketplaces;
  return kit;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/** settings.json, the plugin registry, each enabled plugin's install dir and its
 *  marketplace checkout, and the jobs repos. Also the marketplace registry,
 *  narrowed to those marketplaces with autoUpdate off: a registered marketplace
 *  whose checkout is missing, or one that auto-updates, is re-cloned from GitHub
 *  by every job (14 marketplaces, daisyui alone ~28 MB, on each run). */
function pluginKit(claudeDir: string): { paths: string[]; knownMarketplaces: string } {
  const enabled = Object.entries(asRecord(readJson(join(claudeDir, "settings.json")).enabledPlugins))
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  const installed = asRecord(readJson(join(claudeDir, "plugins", "installed_plugins.json")).plugins);
  const installDirs = enabled.flatMap((id) =>
    (Array.isArray(installed[id]) ? installed[id] : []).flatMap((entry: unknown) => {
      const p = asRecord(entry).installPath;
      return typeof p === "string" ? [relative(claudeDir, p)] : [];
    }),
  );
  const known = readJson(join(claudeDir, "plugins", "known_marketplaces.json"));
  const markets: Record<string, unknown> = {};
  const marketDirs: string[] = [];
  for (const name of new Set(enabled.map((id) => id.slice(id.lastIndexOf("@") + 1)))) {
    const entry = asRecord(known[name]);
    if (typeof entry.installLocation !== "string") continue;
    markets[name] = { ...entry, autoUpdate: false };
    marketDirs.push(relative(claudeDir, entry.installLocation));
  }
  // Routines @include files from the jobs repos, so they travel too (sandbox.sh drops .git).
  const jobsRepos = relative(claudeDir, JOBS_REPOS_PARENT_DIR);
  const paths = ["settings.json", "plugins/installed_plugins.json", ...installDirs, ...marketDirs, jobsRepos].filter(
    (p) => !p.startsWith("..") && existsSync(join(claudeDir, p)),
  );
  return { paths, knownMarketplaces: Object.keys(markets).length ? JSON.stringify(markets) : "" };
}
