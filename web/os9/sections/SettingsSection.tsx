import {
  Button,
  Checkbox,
  ListView,
  TextField,
  Window,
} from "@liiift-studio/mac-os9-ui";
import { Os9Scroll } from "../components/Os9Scroll";
import { Os9Select } from "../components/Os9Select";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { VantaPreview } from "../components/VantaPreview";
import {
  DESKTOP_PRESETS,
  useDesktop,
  type BackgroundPreset,
} from "../useDesktop";
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  type McpListResponse,
  type McpServer,
} from "../../api/mcp";
import { listRepos, syncRepo, type RepoStatus } from "../../api/repos";
import {
  getSettings,
  updateSettings,
  type Settings,
} from "../../api/settings";
import { getState, type StateResponse } from "../../api/state";

const MODELS = [
  { value: "claude-opus-4-7", label: "Opus 4.7" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

const SECURITY = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "bypassPermissions", label: "Bypass Permissions" },
  { value: "plan", label: "Plan" },
];

type PanelKey = "general" | "desktop" | "repos" | "mcps";

interface SectionProps {
  maxHeight: number;
  /** When true, skip the outer `<Window>` / `<Os9Scroll>` chrome — the host
   *  (e.g. osish) already provides its own window + scroll. */
  bare?: boolean;
  /** Which panels to render. Defaults to all. */
  panels?: PanelKey[];
}

export function SettingsSection({ maxHeight, bare, panels }: SectionProps) {
  const show = (k: PanelKey) => !panels || panels.includes(k);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<StateResponse | null>(null);
  const [model, setModel] = useState("");
  const [security, setSecurity] = useState("default");
  const [tz, setTz] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [s, st] = await Promise.all([getSettings(), getState()]);
        setSettings(s);
        setState(st);
        setModel(st.model);
        setSecurity(s.security.level);
        setTz(s.timezone);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateSettings({
        model,
        security: { level: security },
        timezone: tz,
      });
      const [s, st] = await Promise.all([getSettings(), getState()]);
      setSettings(s);
      setState(st);
      alert("Settings saved.");
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [model, security, tz]);

  const innerMax = Math.max(200, maxHeight - 36);

  if (loading || !settings || !state) {
    const loadingNode = <p style={{ padding: 16 }}>Loading…</p>;
    return bare ? loadingNode : <Window title="Settings">{loadingNode}</Window>;
  }

  const body = (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 8,
          }}
        >
          {show("general") ? (
            <fieldset style={{ padding: 8 }}>
              <legend>General</legend>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label>
                  <div style={{ fontSize: 11, marginBottom: 2 }}>Model</div>
                  <Os9Select value={model} onChange={setModel} options={MODELS} />
                </label>
                <label>
                  <div style={{ fontSize: 11, marginBottom: 2 }}>Security</div>
                  <Os9Select
                    value={security}
                    onChange={setSecurity}
                    options={SECURITY}
                  />
                </label>
                <label>
                  <div style={{ fontSize: 11, marginBottom: 2 }}>Timezone</div>
                  <TextField
                    value={tz}
                    onChange={(e) => setTz(e.target.value)}
                    placeholder="America/New_York"
                    fullWidth
                  />
                </label>
                <div>
                  <Button
                    variant="primary"
                    onClick={() => void handleSave()}
                    loading={saving}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </fieldset>
          ) : null}

          {show("desktop") ? <DesktopPanel /> : null}
          {show("repos") ? <ReposPanel /> : null}
          {show("mcps") ? <McpsPanel /> : null}
        </div>
  );

  if (bare) return body;
  return (
    <Window title="Settings">
      <Os9Scroll maxHeight={innerMax}>{body}</Os9Scroll>
    </Window>
  );
}

function PresetTile({
  preset,
  selected,
  onSelect,
}: {
  preset: BackgroundPreset;
  selected: boolean;
  onSelect: () => void;
}) {
  const W = 64;
  const H = 48;
  const border = selected ? "2px solid #4040c0" : "1px solid #888";
  const baseBtn: CSSProperties = {
    background: "transparent",
    border: 0,
    padding: 0,
    display: "block",
    cursor: "pointer",
  };

  if (preset.bg.kind === "vanta") {
    return (
      <button
        type="button"
        title={preset.label}
        aria-label={preset.label}
        onClick={onSelect}
        style={baseBtn}
      >
        <span style={{ display: "block", width: W, height: H, border }}>
          <VantaPreview
            effect={preset.bg.effect}
            options={preset.bg.options}
            width={W - 2}
            height={H - 2}
          />
        </span>
      </button>
    );
  }

  const previewStyle: CSSProperties = {
    width: W,
    height: H,
    background: preset.bg.url
      ? `#999 url("${preset.bg.url}") ${
          preset.bg.tile ? "repeat" : "center / cover no-repeat"
        }`
      : "#999",
    border,
    display: "block",
  };
  return (
    <button
      type="button"
      title={preset.label}
      aria-label={preset.label}
      onClick={onSelect}
      style={baseBtn}
    >
      <span style={previewStyle} aria-hidden />
    </button>
  );
}

function DesktopPanel() {
  const { bg, setBg, url, tile, setUrl, setTile, presetMatches } = useDesktop();

  return (
    <fieldset style={{ padding: 8 }}>
      <legend>Background</legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div>
          <div style={{ fontSize: 11, marginBottom: 4 }}>Preset</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, 64px)",
              gap: 8,
            }}
          >
            {DESKTOP_PRESETS.map((p) => (
              <PresetTile
                key={p.label}
                preset={p}
                selected={presetMatches(p)}
                onSelect={() => setBg(p.bg)}
              />
            ))}
          </div>
        </div>
        <label>
          <div style={{ fontSize: 11, marginBottom: 2 }}>
            Custom image URL (overrides preset)
          </div>
          <TextField
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… or data:image/…"
            fullWidth
          />
        </label>
        <Checkbox
          checked={tile}
          onChange={(e) => setTile(e.target.checked)}
          label="Tile the image"
        />
      </div>
    </fieldset>
  );
}

function ReposPanel() {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftBranch, setDraftBranch] = useState("main");

  const reload = useCallback(async () => {
    try {
      setRepos(await listRepos());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleSync = async (slug: string) => {
    setSyncing(slug);
    try {
      await syncRepo(slug);
      await reload();
    } finally {
      setSyncing(null);
    }
  };

  const handleAdd = async () => {
    const url = draftUrl.trim();
    if (!url) return;
    setAdding(true);
    try {
      // Append new repo to settings.jobsRepos and let the daemon clone it.
      const current = await getSettings();
      const currentRepos = Array.isArray(
        (current as unknown as { jobsRepos?: unknown[] }).jobsRepos,
      )
        ? ((current as unknown as { jobsRepos: unknown[] }).jobsRepos as Array<{
            url: string;
            branch?: string;
            intervalSeconds?: number;
          }>)
        : [];
      const merged = [
        ...currentRepos,
        {
          url,
          branch: draftBranch.trim() || "main",
          intervalSeconds: 300,
        },
      ];
      await updateSettings({ jobsRepos: merged });
      setDraftUrl("");
      setDraftBranch("main");
      await reload();
    } catch (err) {
      alert(`Add failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <fieldset style={{ padding: 8 }}>
      <legend>Plugin repos</legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr auto",
            gap: 6,
            alignItems: "end",
          }}
        >
          <label>
            <div style={{ fontSize: 11, marginBottom: 2 }}>Repo URL</div>
            <TextField
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="https://github.com/you/repo.git"
              fullWidth
            />
          </label>
          <label>
            <div style={{ fontSize: 11, marginBottom: 2 }}>Branch</div>
            <TextField
              value={draftBranch}
              onChange={(e) => setDraftBranch(e.target.value)}
              placeholder="main"
              fullWidth
            />
          </label>
          <Button
            variant="primary"
            onClick={() => void handleAdd()}
            loading={adding}
            disabled={!draftUrl.trim()}
          >
            Add
          </Button>
        </div>

        {loading ? (
          <p>Loading…</p>
        ) : repos.length === 0 ? (
          <p style={{ color: "#555" }}>No repos configured.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {repos.map((r) => (
              <div
                key={r.slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: 4,
                  border: "1px solid #888",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: "bold" }}>{r.slug}</div>
                  <div style={{ fontSize: 11, color: "#555" }}>{r.url}</div>
                </div>
                <Button
                  onClick={() => void handleSync(r.slug)}
                  loading={syncing === r.slug}
                >
                  Sync
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </fieldset>
  );
}

function McpsPanel() {
  const [list, setList] = useState<McpListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    transport: "stdio" as McpServer["transport"],
    target: "",
  });

  const reload = useCallback(async () => {
    try {
      setList(await listMcpServers());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleAdd = async () => {
    if (!draft.name.trim() || !draft.target.trim()) return;
    setAdding(true);
    try {
      await addMcpServer({
        name: draft.name.trim(),
        transport: draft.transport,
        target: draft.target.trim(),
        scope: "user",
      });
      setDraft({ name: "", transport: "stdio", target: "" });
      await reload();
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (name: string, scope: McpServer["scope"]) => {
    await removeMcpServer(name, scope);
    await reload();
  };

  if (loading || !list) {
    return (
      <fieldset style={{ padding: 8 }}>
        <legend>MCP servers</legend>
        <p>Loading…</p>
      </fieldset>
    );
  }

  const all = [
    ...list.user.map((s) => ({ ...s, scope: "user" as const })),
    ...list.project.map((s) => ({ ...s, scope: "project" as const })),
  ];

  return (
    <fieldset style={{ padding: 8 }}>
      <legend>MCP servers</legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 2fr auto",
            gap: 6,
          }}
        >
          <TextField
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="name"
            fullWidth
          />
          <Os9Select
            value={draft.transport}
            onChange={(v) =>
              setDraft({ ...draft, transport: v as McpServer["transport"] })
            }
            options={[
              { value: "stdio", label: "stdio" },
              { value: "http", label: "http" },
              { value: "sse", label: "sse" },
            ]}
          />
          <TextField
            value={draft.target}
            onChange={(e) => setDraft({ ...draft, target: e.target.value })}
            placeholder={draft.transport === "stdio" ? "command args" : "https://…"}
            fullWidth
          />
          <Button
            variant="primary"
            onClick={() => void handleAdd()}
            loading={adding}
            disabled={!draft.name.trim() || !draft.target.trim()}
          >
            Add
          </Button>
        </div>

        {all.length === 0 ? (
          <p style={{ color: "#555" }}>No MCP servers configured.</p>
        ) : (
          <ListView
            columns={[
              { key: "name", label: "Name", width: "30%" },
              { key: "scope", label: "Scope", width: "15%" },
              { key: "transport", label: "Transport", width: "15%" },
              { key: "target", label: "Target", width: "40%" },
            ]}
            items={all.map((s) => ({
              id: `${s.scope}:${s.name}`,
              name: s.name,
              scope: s.scope,
              transport: s.transport,
              target: s.target,
            }))}
            onItemOpen={(item) => {
              const [scope, name] = String(item.id).split(":");
              if (scope && name) {
                void handleRemove(name, scope as McpServer["scope"]);
              }
            }}
          />
        )}
        <div style={{ color: "#555", fontSize: 11 }}>
          Double-click a server to remove it.
        </div>
      </div>
    </fieldset>
  );
}
