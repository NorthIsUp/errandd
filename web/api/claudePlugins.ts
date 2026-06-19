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
