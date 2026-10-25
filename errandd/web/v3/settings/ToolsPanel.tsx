import { ChevronRight, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { listPlugins, type InstalledPlugin } from "../../api/claudePlugins";
import { CopyButton } from "../../components/CopyButton";
import type { StateResponse } from "../../api/state";
import { InstalledPluginRow, PluginAutoUpdateCard } from "../../ui/sections/SettingsSection";
import { useAsync } from "../../ui/useAsync";
import { SettingsBadge, SettingsPanel, SettingsRow } from "./parts";
const EMPTY_PLUGINS: InstalledPlugin[] = [];
export function ToolsPanel({
  state,
  tab,
  onTab,
}: {
  state: StateResponse;
  tab: string;
  onTab: (tab: string) => void;
}) {
  const [filter, setFilter] = useState("enabled"),
    [query, setQuery] = useState("");
  const plugins = useAsync(() => listPlugins());
  const installed = plugins.data?.installed ?? EMPTY_PLUGINS;
  const groups = useMemo(() => {
    const byId = new Map<string, InstalledPlugin[]>();
    for (const plugin of installed) {
      const list = byId.get(plugin.id) ?? [];
      list.push(plugin);
      byId.set(plugin.id, list);
    }
    return [...byId.entries()]
      .filter(
        ([id, entries]) =>
          id.toLowerCase().includes(query.toLowerCase()) &&
          (filter === "all" || entries.some((p) => p.enabled) === (filter === "enabled")),
      )
      .sort(([a], [b]) => a.localeCompare(b));
  }, [installed, query, filter]);
  const enabledIds = new Map<string, Set<string>>();
  for (const plugin of installed) {
    if (!plugin.enabled) continue;
    const name = plugin.id.split("@")[0] ?? plugin.id;
    const ids = enabledIds.get(name) ?? new Set<string>();
    ids.add(plugin.id);
    enabledIds.set(name, ids);
  }
  const servers = [...state.mcpServers].sort(
    (a, b) => Number(a.status === "ok") - Number(b.status === "ok"),
  );
  return (
    <>
      <div className="settings-page-title">
        <h1>Tools & plugins</h1>
        <p>Connections and extensions available to {state.runtime.id ?? "the coding agent"}.</p>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Tools and plugins">
        <button
          type="button"
          role="tab"
          aria-selected={tab !== "plugins"}
          onClick={() => onTab("mcp")}
        >
          Tool connections · {servers.length}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "plugins"}
          onClick={() => onTab("plugins")}
        >
          Plugins{plugins.data ? ` · ${installed.length}` : ""}
        </button>
      </div>
      {tab !== "plugins" ? (
        <SettingsPanel
          title="MCP connections"
          description="Registration is managed by the runtime or deployment. Connections needing attention appear first."
        >
          {servers.length ? (
            servers.map((server) => (
              <details key={server.name}>
                <summary>
                  <SettingsRow
                    title={server.name}
                    description={
                      server.issue ??
                      (server.transport === "stdio"
                        ? "Local tool process"
                        : `${server.transport.toUpperCase()} connection`)
                    }
                  >
                    <SettingsBadge
                      tone={
                        server.status === "ok"
                          ? "good"
                          : server.status === "unknown"
                            ? "neutral"
                            : "warning"
                      }
                    >
                      {server.status === "ok"
                        ? "Connected"
                        : server.status === "warn"
                          ? "Needs attention"
                          : server.status === "error"
                            ? "Error"
                            : "Unknown"}
                    </SettingsBadge>
                  </SettingsRow>
                </summary>
                <div className="settings-copy-box">
                  <code>{server.target}</code>
                  <CopyButton text={server.target} label="MCP connection" />
                </div>
              </details>
            ))
          ) : (
            <p className="settings-hint">No MCP connections reported by this runtime.</p>
          )}
        </SettingsPanel>
      ) : (
        <>
          {state.runtime.capabilities?.supportsPlugins === false && (
            <p className="settings-hint">
              This runtime manages extensions outside the dashboard. The list below is the installed
              Claude plugin inventory.
            </p>
          )}
          <div className="settings-plugin-filters">
            <div className="settings-tabs" role="group" aria-label="Plugin state">
              {["enabled", "all", "disabled"].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value === "enabled"
                    ? `Enabled · ${installed.filter((p) => p.enabled).length}`
                    : value === "all"
                      ? `All · ${installed.length}`
                      : "Disabled"}
                </button>
              ))}
            </div>
            <label className="settings-plugin-search">
              <Search size={15} />
              <input
                aria-label="Find a plugin"
                placeholder="Find a plugin…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <SettingsPanel
            title={`${groups.length} plugin${groups.length === 1 ? "" : "s"}`}
            description="Installations are grouped by plugin; inspect scopes before changing an override."
          >
            <button
              type="button"
              className="settings-link"
              disabled={plugins.loading}
              onClick={plugins.reload}
            >
              <RefreshCw size={14} />
              Refresh inventory
            </button>
            {plugins.error != null && (
              <p role="alert" className="settings-error">
                {plugins.error instanceof Error ? plugins.error.message : "Could not load plugins"}
              </p>
            )}
            {plugins.loading && !plugins.data && <p>Loading plugins…</p>}
            {groups.map(([id, entries]) => (
              <details className="settings-plugin-group" key={id}>
                <summary>
                  <span>
                    <strong>{id.split("@")[0]}</strong>
                    <small>{id.split("@")[1] ?? "local"}</small>
                  </span>
                  <span className="settings-row-actions">
                    {entries.length > 1 && <SettingsBadge>{entries.length} scopes</SettingsBadge>}
                    <SettingsBadge tone={entries.some((p) => p.enabled) ? "good" : "neutral"}>
                      {entries.some((p) => p.enabled) ? "Enabled" : "Disabled"}
                    </SettingsBadge>
                    <ChevronRight size={14} />
                  </span>
                </summary>
                <ul className="settings-plugin-scopes">
                  {entries.map((plugin) => (
                    <InstalledPluginRow
                      key={`${plugin.id}:${plugin.scope}:${plugin.projectPath ?? ""}`}
                      plugin={plugin}
                      onChanged={plugins.reload}
                      isDup={
                        plugin.enabled &&
                        (enabledIds.get(plugin.id.split("@")[0] ?? plugin.id)?.size ?? 0) > 1
                      }
                      display={{ showVersion: true, showScope: true }}
                    />
                  ))}
                </ul>
              </details>
            ))}
            {plugins.data && !groups.length && (
              <p className="settings-hint">No matching plugins.</p>
            )}
          </SettingsPanel>
          <PluginAutoUpdateCard />
        </>
      )}
    </>
  );
}
