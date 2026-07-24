import { apiJSON } from "./client";

export interface Marketplace {
  name: string;
  source: string;
  repo?: string;
  url?: string;
  installLocation: string;
}

export interface InstalledPlugin {
  id: string;
  version: string;
  scope: "user" | "project" | "local" | "managed";
  enabled: boolean;
  installPath: string;
  installedAt?: string;
  lastUpdated?: string;
  projectPath?: string;
  /** Skill / command / agent names the plugin ships (enumerated by the
   *  daemon from installPath). Rendered as display-only child nodes under
   *  the plugin in the dashboard tree — Claude Code has no native per-skill
   *  enable/disable, so the whole plugin is governed by `enabled`. */
  skills?: string[];
  commands?: string[];
  agents?: string[];
  /** True when the plugin's GitOps default is ENABLED (its id is in preflight's
   *  DEFAULT_ENABLED allowlist). Drives the `●` marker: for a plugin with no
   *  local override, `●` present ⟺ toggle ON. */
  gitopsDefaultEnabled?: boolean;
  /** True when the effective `enabled` state differs from `gitopsDefaultEnabled`
   *  — a deliberate local override (drift). Drives the "overridden" marker. */
  overridden?: boolean;
}

export interface AvailablePlugin {
  pluginId: string;
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

/** Muted label shown when a plugin op fails because the plugin is gitops /
 *  project-managed. Matches the "Configured via GitOps" wording used for the
 *  Git identity card (PR #258) so the two managed-by-gitops surfaces read the
 *  same. */
export const GITOPS_MANAGED_LABEL = "Managed via GitOps";

/** True when a `claude plugin` CLI error was caused by the plugin being managed
 *  at PROJECT scope (gitops-provisioned into `.claude/settings.json`, shared
 *  with the team) rather than a genuine failure. The CLI phrases this as e.g.
 *  `… is enabled at project scope (.claude/settings.json, shared with your
 *  team). To disable just for you: … --scope local`. We classify on those
 *  stable signals so every surface (badge, tooltip, any error text) can show
 *  the calm "Managed via GitOps" state instead of an alarming red "failed".
 *  Genuine failures (network, missing plugin, npm install) don't carry these
 *  phrases and keep the real error. */
export function isGitOpsManagedError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("project scope") ||
    m.includes("shared with your team") ||
    m.includes("managed")
  );
}

export function listMarketplaces(): Promise<Marketplace[]> {
  return apiJSON<Marketplace[]>("/api/claude-plugins/marketplaces");
}

export function addMarketplace(ref: string): Promise<CliResult> {
  return apiJSON<CliResult>("/api/claude-plugins/marketplaces", {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
}

export function removeMarketplace(name: string): Promise<CliResult> {
  return apiJSON<CliResult>(`/api/claude-plugins/marketplaces/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function updateMarketplace(name: string): Promise<CliResult> {
  return apiJSON<CliResult>(`/api/claude-plugins/marketplaces/${encodeURIComponent(name)}/update`, {
    method: "POST",
  });
}

export function updateAllMarketplaces(): Promise<CliResult> {
  return apiJSON<CliResult>("/api/claude-plugins/marketplaces/update-all", {
    method: "POST",
  });
}

export function listPlugins(): Promise<{ installed: InstalledPlugin[]; available: AvailablePlugin[] }> {
  return apiJSON<{ installed: InstalledPlugin[]; available: AvailablePlugin[] }>(
    "/api/claude-plugins",
  );
}

export function installPlugin(id: string): Promise<CliResult> {
  return apiJSON<CliResult>("/api/claude-plugins/install", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function uninstallPlugin(id: string): Promise<CliResult> {
  return apiJSON<CliResult>(`/api/claude-plugins/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function updatePlugin(id: string): Promise<CliResult> {
  return apiJSON<CliResult>(`/api/claude-plugins/${encodeURIComponent(id)}/update`, {
    method: "POST",
  });
}

export function enablePlugin(id: string): Promise<CliResult> {
  return apiJSON<CliResult>(`/api/claude-plugins/${encodeURIComponent(id)}/enable`, {
    method: "POST",
  });
}

export function disablePlugin(id: string): Promise<CliResult> {
  return apiJSON<CliResult>(`/api/claude-plugins/${encodeURIComponent(id)}/disable`, {
    method: "POST",
  });
}

export function updateAllPlugins(): Promise<{
  results: { id: string; result: CliResult }[];
}> {
  return apiJSON<{ results: { id: string; result: CliResult }[] }>(
    "/api/claude-plugins/update-all",
    { method: "POST" },
  );
}
