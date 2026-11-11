// What a sandboxed job needs that a fresh pod lacks: the daemon's GitHub auth,
// its http MCP servers, and its enabled Claude plugins. The daemon stays the
// single source of truth; sandbox.sh ships this into the pod per job.

import { existsSync, readFileSync } from "fs";
import { basename, join, relative } from "path";
import { asRecord, type McpServerSpec } from "../config";

export interface SandboxKit {
  /** Forwarded over exec stdin as-is (bypasses the generic env allowlist). */
  env: Record<string, string>;
  /** Inserted right after the executable. */
  args: string[];
  /** Files under `claudeDir` to stream into the pod's ~/.claude. */
  paths: string[];
  claudeDir: string;
}

export const EMPTY_KIT: SandboxKit = { env: {}, args: [], paths: [], claudeDir: "" };

export function buildSandboxKit(
  exe: string,
  mcpServers: McpServerSpec[],
  env: Record<string, string>,
  claudeDir: string,
  ghToken: string | null,
): SandboxKit {
  const kit: SandboxKit = { env: {}, args: [], paths: [], claudeDir };
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

  const servers: Record<string, unknown> = {};
  for (const s of mcpServers) {
    // stdio servers need the daemon's local processes and env; only remote ones travel.
    if (s.enabled === false || s.transport === "stdio") continue;
    const required = s.requireEnv ?? [];
    if (!required.every((k) => env[k]?.trim())) continue;
    for (const k of required) kit.env[k] = env[k] ?? "";
    const headers = Object.fromEntries(
      (s.headers ?? []).map((h) => {
        const i = h.indexOf(":");
        return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
      }),
    );
    // Header values keep their ${VAR} placeholders; the CLI expands them from the forwarded env.
    servers[s.name] = { type: s.transport, url: s.target, headers };
  }
  if (Object.keys(servers).length) kit.args = ["--mcp-config", JSON.stringify({ mcpServers: servers })];

  kit.paths = pluginPaths(claudeDir);
  return kit;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/** settings.json, the plugin registries, and the install dir of each enabled plugin. */
function pluginPaths(claudeDir: string): string[] {
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
  return ["settings.json", "plugins/installed_plugins.json", "plugins/known_marketplaces.json", ...installDirs]
    .filter((p) => !p.startsWith("..") && existsSync(join(claudeDir, p)));
}
