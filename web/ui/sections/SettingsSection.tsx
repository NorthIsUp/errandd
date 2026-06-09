import { AlertTriangle, CheckCircle2, Download, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  disablePlugin,
  enablePlugin,
  type InstalledPlugin,
  listPlugins,
  uninstallPlugin,
  updatePlugin,
} from "../../api/claudePlugins";
import { listRepos, type RepoStatus, syncRepo } from "../../api/repos";
import { applyUpdate, checkForUpdate, type UpdateCheck } from "../../api/runtime";
import {
  getHeartbeatSettings,
  type HeartbeatSettings,
  updateHeartbeatSettings,
  updateSettings,
} from "../../api/settings";
import type { StateResponse } from "../../api/state";
import { getState } from "../../api/state";
import { Card } from "../components/Card";
import { InputWithAction } from "../components/InputWithAction";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { ReceiverCard } from "../components/ReceiverCard";
import { SaveStatus } from "../components/SaveStatus";
import { useRoute } from "../router";
import {
  DARK_THEMES,
  LIGHT_THEMES,
  setDarkTheme,
  setLightTheme,
  setMode,
  type ThemeMode,
  useThemeState,
} from "../theme";
import { useAsync } from "../useAsync";
import { useAutosave } from "../useAutosave";

// Sections rendered in order on the single Settings page. The section ids
// double as hash anchors so deep links like `/ui/#/settings/model` jump
// to a section instead of opening a separate sub-page.
const SECTIONS = [
  { id: "model", label: "Default model" },
  { id: "sources", label: "Sources" },
  { id: "hooks", label: "Webhook receiver" },
  { id: "git", label: "Git identity" },
  { id: "heartbeat", label: "Heartbeat" },
  { id: "appearance", label: "Appearance" },
] as const;

/**
 * @param hideAppearance v3 reuses this panel for its functional settings but
 *   owns its own theme system (Abyssal/Tidepool/etc. via the sidebar picker).
 *   The legacy "Appearance" controls here write the old `clawdcode:theme` keys
 *   and would fight v3's `data-theme`, so v3 passes `hideAppearance` to drop it.
 */
export function SettingsSection({ hideAppearance = false }: { hideAppearance?: boolean } = {}) {
  const { route } = useRoute();
  const targetSection = route.segments[0];
  const sections = hideAppearance ? SECTIONS.filter((s) => s.id !== "appearance") : SECTIONS;

  // Scroll the target section into view when the route specifies one. We
  // rely on each section having an `id` matching its route segment.
  if (targetSection) {
    queueMicrotask(() => {
      document.getElementById(`settings-${targetSection}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  return (
    <>
      <PageHeader title="Settings" crumbs={[{ label: "Settings" }]} />

      <UpdateBanner />
      <TailnetBanner />

      <nav aria-label="Sections" className="flex flex-wrap gap-2 text-sm">
        {sections.map((s) => (
          <a
            key={s.id}
            href={`${location.pathname}#/settings/${s.id}`}
            className="link link-hover text-base-content/70 hover:text-base-content"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <SettingsSubsection id="model" label="Default model">
        <ModelPanel />
      </SettingsSubsection>
      <SettingsSubsection id="sources" label="Sources">
        <ReposPanel />
      </SettingsSubsection>
      <SettingsSubsection id="hooks" label="Webhook receiver">
        <WebhookReceiverPanel />
      </SettingsSubsection>
      <SettingsSubsection id="git" label="Git identity">
        <GitIdentityPanel />
      </SettingsSubsection>
      <SettingsSubsection id="heartbeat" label="Heartbeat">
        <HeartbeatPanel />
      </SettingsSubsection>
      {!hideAppearance && (
        <SettingsSubsection id="appearance" label="Appearance">
          <AppearancePanel />
        </SettingsSubsection>
      )}
    </>
  );
}

/**
 * Top-of-Settings banner that reports how far behind origin the running
 * checkout is. When `canPull` and `behind > 0`, exposes an "Update now"
 * button that does `git pull --ff-only`. After a successful pull we show
 * a "Restart daemon" hint — the running process can't safely swap its
 * own code, so the user (or supervisor) needs to bounce it.
 */
function UpdateBanner() {
  const check = useAsync<UpdateCheck>(() => checkForUpdate());
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatedSha, setUpdatedSha] = useState<string | null>(null);

  async function onUpdate() {
    setUpdating(true);
    setUpdateError(null);
    setUpdatedSha(null);
    try {
      const result = await applyUpdate();
      if (result.ok) {
        setUpdatedSha(result.newSha);
        // Refresh the check so the banner reflects the new state.
        check.reload();
      } else {
        setUpdateError(result.error ?? "update failed");
      }
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  }

  if (check.loading || !check.data) {
    return null;
  }
  const data = check.data;

  // Just-pulled — show the "restart to apply" hint until the user dismisses
  // (next page load will detect a fresh check and hide).
  if (updatedSha) {
    return (
      <div className="alert alert-success">
        <CheckCircle2 size={16} />
        <span>
          Updated to <code className="font-mono">{updatedSha.slice(0, 8)}</code>. Restart the daemon
          to apply.
        </span>
      </div>
    );
  }

  if (data.behind > 0) {
    return (
      <div className="alert alert-warning flex flex-wrap items-center gap-2">
        <Download size={16} />
        <div className="flex-1 min-w-0">
          <div className="font-medium">
            Update available · {data.behind} commit{data.behind === 1 ? "" : "s"} behind{" "}
            <code className="font-mono">{data.branch}</code>
          </div>
          {data.compareUrl && (
            <a
              href={data.compareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs link link-hover"
            >
              See what changed →
            </a>
          )}
          {updateError && <div className="text-xs text-error mt-1">{updateError}</div>}
        </div>
        {data.canPull ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onUpdate}
            disabled={updating}
          >
            {updating ? "Updating…" : "Update now"}
          </button>
        ) : (
          <span
            className="badge badge-ghost gap-1"
            title={data.error ?? "Cannot self-pull in this deployment"}
          >
            <AlertTriangle size={12} /> re-deploy to update
          </span>
        )}
      </div>
    );
  }

  // Up to date — no chrome.
  return null;
}

/**
 * Renders a small "signed in via tailnet" hint when the daemon was launched
 * with `--web-trust-tailnet` and the current request carried the
 * `Tailscale-User-Login` header. Stays hidden otherwise so the token/cookie
 * path looks unchanged.
 */
function TailnetBanner() {
  const state = useAsync<StateResponse>(() => getState());
  const tailnet = state.data?.tailnet;
  if (!tailnet) {
    return null;
  }
  const label = tailnet.displayName ? `${tailnet.displayName} (${tailnet.login})` : tailnet.login;
  return (
    <div className="alert alert-info flex flex-wrap items-center gap-2 py-2 text-sm">
      <CheckCircle2 size={14} />
      <span>
        Signed in via tailnet as <code className="font-mono">{label}</code>
        {tailnet.tailnet ? (
          <>
            {" "}
            on <code className="font-mono">{tailnet.tailnet}</code>
          </>
        ) : null}
      </span>
    </div>
  );
}

function SettingsSubsection({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={`settings-${id}`}
      // Offset for the sticky topbar so deep-link scroll lands below it.
      className="scroll-mt-20"
    >
      <h2 className="text-lg font-semibold mb-2">{label}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

interface RepoUrlEntry {
  id: number;
  url: string;
  kind: "git" | "plugin";
}
let repoEntrySeq = 0;

// Expand `org/repo` (or `org/repo.git`) shorthand to a full GitHub HTTPS URL.
// Anything that already looks like a URL (https://, git@, ssh://, …) or a
// filesystem path is returned unchanged.
const REPO_SHORTHAND_RE = /^[\w.-]+\/[\w.-]+$/;
function expandRepoShorthand(raw: string): string {
  if (!(raw && REPO_SHORTHAND_RE.test(raw))) {
    return raw;
  }
  const trimmed = raw.replace(/\.git$/i, "");
  return `https://github.com/${trimmed}.git`;
}

function ReposPanel() {
  const state = useAsync<StateResponse>(() => getState());
  const repos = useAsync<RepoStatus[]>(() => listRepos());
  const [urls, setUrls] = useState<RepoUrlEntry[]>([]);
  const [seenState, setSeenState] = useState<unknown>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncAllError, setSyncAllError] = useState<unknown>(null);

  async function syncAll() {
    if (!repos.data || repos.data.length === 0) {
      return;
    }
    setSyncingAll(true);
    setSyncAllError(null);
    try {
      // Run sequentially so we don't pile concurrent git operations on the
      // same daemon. syncRepo clones-if-missing before staging, so this
      // works on freshly-added repos too. Surface per-repo errors as the
      // first failure we hit, since one bad URL shouldn't silently swallow
      // its result.
      for (const r of repos.data) {
        const result = await syncRepo(r.slug);
        if (!result.ok) {
          throw new Error(`${r.slug}: ${result.error ?? "sync failed"}`);
        }
      }
      repos.reload();
    } catch (e) {
      setSyncAllError(e);
    } finally {
      setSyncingAll(false);
    }
  }

  if (state.data && state.data !== seenState) {
    setSeenState(state.data);
    setUrls(
      state.data.jobsRepos.map((r) => ({
        id: ++repoEntrySeq,
        url: r.url,
        kind: r.kind ?? "git",
      })),
    );
  }

  function update(id: number, v: string) {
    setUrls((u) => u.map((e) => (e.id === id ? { ...e, url: v } : e)));
  }
  function addGit() {
    setUrls((u) => [...u, { id: ++repoEntrySeq, url: "", kind: "git" }]);
  }
  function addPlugin() {
    setUrls((u) => [...u, { id: ++repoEntrySeq, url: "", kind: "plugin" }]);
  }
  function remove(id: number) {
    setUrls((u) => u.filter((e) => e.id !== id));
  }

  const { status, error: err } = useAutosave(
    urls,
    async (next) => {
      // Expand `org/repo` shorthand to a full GitHub HTTPS URL for git
      // entries — plugin entries already use a `<marketplace>/<plugin>`
      // form that's the literal input to `claude plugin install`, so don't
      // touch them.
      const expandedEntries = next.map((e) => ({
        ...e,
        url: e.kind === "git" ? expandRepoShorthand(e.url.trim()) : e.url.trim(),
      }));
      const cleaned = expandedEntries.filter((e) => e.url.length > 0);
      const existing = state.data?.jobsRepos ?? [];
      const payload = cleaned.map((entry) => {
        const found = existing.find((r) => r.url === entry.url && r.kind === entry.kind);
        return {
          kind: entry.kind,
          url: entry.url,
          branch: found?.branch ?? "main",
          intervalSeconds: found?.intervalSeconds ?? 300,
        };
      });
      await updateSettings({ jobsRepos: payload });
      setUrls(expandedEntries);
      state.reload();
      repos.reload();
    },
    { enabled: state.data !== null },
  );

  const hasRepos = !!repos.data && repos.data.length > 0;
  const gitEntries = urls.map((u, i) => ({ ...u, i })).filter((e) => e.kind === "git");
  const pluginEntries = urls.map((u, i) => ({ ...u, i })).filter((e) => e.kind === "plugin");
  const gitStatus = repos.data?.filter((r) => r.kind === "git") ?? [];
  const pluginStatus = repos.data?.filter((r) => r.kind === "plugin") ?? [];

  return (
    <div className="space-y-3">
      {state.error ? <ErrorBanner error={state.error} /> : null}
      {err ? <ErrorBanner error={err} /> : null}
      {syncAllError ? <ErrorBanner error={syncAllError} /> : null}

      <Card
        title="Git repos"
        actions={
          <>
            <SaveStatus status={status} />
            {hasRepos && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={syncAll}
                disabled={syncingAll}
                title="Pull + push every configured source"
              >
                <RefreshCw size={14} className={syncingAll ? "animate-spin" : ""} />
                {syncingAll ? "Syncing all…" : "Sync all"}
              </button>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={addGit}>
              <Plus size={16} /> Add repo
            </button>
          </>
        }
      >
        {state.loading && <Loader />}
        {gitEntries.length === 0 && <Empty>No git repos configured.</Empty>}
        <div className="space-y-2">
          {gitEntries.map((entry) => (
            <InputWithAction
              key={entry.id}
              value={entry.url}
              onChange={(v) => update(entry.id, v)}
              placeholder="git@github.com:org/repo.git"
              aria={`Repo ${entry.i + 1} URL`}
              type="url"
              mono
              action={{
                icon: <Trash2 size={16} />,
                onClick: () => remove(entry.id),
                aria: `Remove repo ${entry.i + 1}`,
                title: "Remove",
              }}
            />
          ))}
        </div>
        {gitStatus.length > 0 && (
          <div className="mt-4 pt-4 border-t border-base-300">
            <h4 className="text-sm font-semibold mb-2">Current status</h4>
            <ul className="text-sm space-y-1">
              {gitStatus.map((r) => (
                <RepoStatusRow key={r.slug} repo={r} onChanged={() => repos.reload()} />
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card
        title="Claude plugins"
        actions={
          <button type="button" className="btn btn-sm btn-primary" onClick={addPlugin}>
            <Plus size={16} /> Add plugin
          </button>
        }
      >
        {pluginEntries.length === 0 && (
          <Empty>
            No claude plugins configured. Add by <code className="font-mono">org/repo</code> (a
            marketplace's GitHub repo).
          </Empty>
        )}
        <div className="space-y-2">
          {pluginEntries.map((entry) => (
            <InputWithAction
              key={entry.id}
              value={entry.url}
              onChange={(v) => update(entry.id, v)}
              placeholder="NorthIsUp/skillz"
              aria={`Plugin ${entry.i + 1} ref`}
              mono
              action={{
                icon: <Trash2 size={16} />,
                onClick: () => remove(entry.id),
                aria: `Remove plugin ${entry.i + 1}`,
                title: "Remove",
              }}
            />
          ))}
        </div>
        {pluginStatus.length > 0 && (
          <div className="mt-4 pt-4 border-t border-base-300">
            <h4 className="text-sm font-semibold mb-2">Current status</h4>
            <ul className="text-sm space-y-1">
              {pluginStatus.map((r) => (
                <RepoStatusRow key={r.slug} repo={r} onChanged={() => repos.reload()} />
              ))}
            </ul>
          </div>
        )}
      </Card>

      <InstalledPluginsCard runtimeVersion={state.data?.runtime.version ?? null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Installed plugins (read-only listing of `claude plugin list --json`)
// ---------------------------------------------------------------------------

/** Lists every plugin installed under the current Claude user/project scope,
 *  plus a synthetic "self" row for clawdcode (which lives on disk as a git
 *  checkout, not as an installed plugin, so it doesn't show up in
 *  `claude plugin list`). Each row offers enable/disable + update + uninstall
 *  except for clawdcode, where uninstall is suppressed — see
 *  `isSelfPluginId` in `src/ui/services/claudePlugins.ts` for the matching
 *  belt-and-suspenders backend check. */
function InstalledPluginsCard({ runtimeVersion }: { runtimeVersion: string | null }) {
  const plugins = useAsync(() => listPlugins());
  const installed = plugins.data?.installed ?? [];

  // Synthesise a "self" row when clawdcode isn't already in the CLI output
  // (it usually isn't — we run from a git checkout).
  const hasSelf = installed.some((p) => isSelfPlugin(p.id));
  const rows: InstalledPlugin[] = hasSelf
    ? installed
    : [
        {
          id: "clawdcode",
          version: runtimeVersion ?? "dev",
          scope: "local",
          enabled: true,
          installPath: "(this daemon)",
        },
        ...installed,
      ];

  return (
    <Card
      title="Installed plugins"
      actions={
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => plugins.reload()}
          disabled={plugins.loading}
          aria-label="Refresh installed plugins"
        >
          <RefreshCw size={14} className={plugins.loading ? "animate-spin" : ""} />
        </button>
      }
    >
      {plugins.loading && !plugins.data && <Loader />}
      {plugins.error ? <ErrorBanner error={plugins.error} /> : null}
      {!plugins.loading && rows.length === 0 && <Empty>No plugins installed.</Empty>}
      {rows.length > 0 && (
        <ul className="text-sm space-y-1">
          {rows.map((p, idx) => (
            <InstalledPluginRow
              key={`${p.id}-${p.scope}-${idx}`}
              plugin={p}
              onChanged={() => plugins.reload()}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function isSelfPlugin(id: string): boolean {
  const name = id.split("@", 1)[0];
  return name === "clawdcode";
}

function InstalledPluginRow({
  plugin,
  onChanged,
}: {
  plugin: InstalledPlugin;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<null | "update" | "uninstall" | "toggle">(null);
  const [err, setErr] = useState<unknown>(null);
  const self = isSelfPlugin(plugin.id);

  async function run(kind: "update" | "uninstall" | "toggle") {
    setBusy(kind);
    setErr(null);
    try {
      const r =
        kind === "update"
          ? await updatePlugin(plugin.id)
          : kind === "uninstall"
            ? await uninstallPlugin(plugin.id)
            : plugin.enabled
              ? await disablePlugin(plugin.id)
              : await enablePlugin(plugin.id);
      if (!r.ok) {
        throw new Error(r.error ?? `${kind} failed`);
      }
      onChanged();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex items-center gap-2 flex-wrap">
      <span className="font-mono">{plugin.id}</span>
      <span className="text-base-content/60 text-xs">v{plugin.version || "?"}</span>
      <span className="badge badge-ghost badge-xs">{plugin.scope}</span>
      {self && <span className="badge badge-info badge-xs">this daemon</span>}
      {!plugin.enabled && <span className="badge badge-warning badge-xs">disabled</span>}
      {err ? (
        <span
          className="badge badge-error badge-xs"
          title={err instanceof Error ? err.message : String(err)}
        >
          failed
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        {!self && (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => run("toggle")}
            disabled={busy !== null}
            title={plugin.enabled ? "Disable" : "Enable"}
          >
            {plugin.enabled ? "Disable" : "Enable"}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => run("update")}
          disabled={busy !== null || self}
          title={self ? "Update clawdcode from the About page" : "Update"}
        >
          {busy === "update" ? "Updating…" : "Update"}
        </button>
        {!self && (
          <button
            type="button"
            className="btn btn-ghost btn-xs text-error"
            onClick={() => run("uninstall")}
            disabled={busy !== null}
            aria-label={`Uninstall ${plugin.id}`}
            title="Uninstall"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

/** Sum the counts across all plugins in the source. */
function repoCounts(repo: RepoStatus): { skills: number; commands: number; agents: number } {
  let skills = 0;
  let commands = 0;
  let agents = 0;
  for (const p of repo.plugins) {
    skills += p.skills.length;
    commands += p.commands.length;
    agents += p.agents?.length ?? 0;
  }
  return { skills, commands, agents };
}

function CountBadges({ repo }: { repo: RepoStatus }) {
  const { skills, commands, agents } = repoCounts(repo);
  const items = [
    { label: "jobs", n: repo.jobs ?? 0 },
    { label: "skills", n: skills },
    { label: "commands", n: commands },
    { label: "agents", n: agents },
  ].filter((b) => b.n > 0);
  if (items.length === 0) {
    return <span className="badge badge-ghost badge-xs">empty</span>;
  }
  return (
    <>
      {items.map((b) => (
        <span key={b.label} className="badge badge-ghost badge-xs">
          {b.n} {b.label}
        </span>
      ))}
    </>
  );
}

function RepoStatusRow({ repo, onChanged }: { repo: RepoStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  // Plugin rows say "Install" (not yet installed) or "Update" (already
  // installed); git rows always say "Sync". Same backend call either way.
  const isPlugin = repo.kind === "plugin";
  const action = isPlugin ? (repo.cloned ? "Update" : "Install") : "Sync";
  const busyAction = isPlugin ? (repo.cloned ? "Updating…" : "Installing…") : "Syncing…";
  async function onAct() {
    setBusy(true);
    setErr(null);
    try {
      const result = await syncRepo(repo.slug);
      if (!result.ok) {
        throw new Error(result.error ?? `${action.toLowerCase()} failed`);
      }
      onChanged();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex items-center gap-2">
      <span className="font-mono">{repo.slug}</span>
      {!isPlugin && <span className="text-base-content/60">{repo.branch}</span>}
      {!repo.cloned && (
        <span className="badge badge-error badge-xs">
          {isPlugin ? "not installed" : "not cloned"}
        </span>
      )}
      {repo.cloned && <CountBadges repo={repo} />}
      {repo.dirty && <span className="badge badge-warning badge-xs">dirty</span>}
      {repo.lastError && (
        <span className="badge badge-error badge-xs" title={repo.lastError}>
          error
        </span>
      )}
      {err ? (
        <span
          className="badge badge-error badge-xs"
          title={err instanceof Error ? err.message : String(err)}
        >
          {action.toLowerCase()} failed
        </span>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost btn-xs ml-auto"
        onClick={onAct}
        disabled={busy}
        aria-label={`${action} ${repo.slug}`}
        title={busy ? busyAction : action}
      >
        <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
        {busy ? busyAction : action}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

function HeartbeatPanel() {
  const hb = useAsync(() => getHeartbeatSettings());
  const [draft, setDraft] = useState<HeartbeatSettings | null>(null);
  const [seenData, setSeenData] = useState<unknown>(null);

  if (hb.data && hb.data !== seenData) {
    setSeenData(hb.data);
    setDraft(hb.data.heartbeat);
  }

  const { status, error: err } = useAutosave(
    draft,
    async (next) => {
      if (!next) {
        return;
      }
      await updateHeartbeatSettings(next);
      hb.reload();
    },
    { enabled: draft !== null },
  );

  return (
    <Card actions={<SaveStatus status={status} />}>
      {hb.loading && <Loader />}
      {hb.error ? <ErrorBanner error={hb.error} /> : null}
      {err ? <ErrorBanner error={err} /> : null}
      {draft && (
        <div className="space-y-4">
          {/* Enabled + Interval share the first row — they're both compact
              scalars and the layout reads better than stacking them. */}
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              <span className="font-medium">Enabled</span>
            </label>

            <label className="form-control">
              <span className="label-text mb-1 text-xs">Interval (minutes)</span>
              <input
                type="number"
                min={1}
                className="input border-base-300 w-32"
                value={Math.round(draft.interval / 60)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    interval: Math.max(60, Number(e.target.value) * 60),
                  })
                }
              />
            </label>
          </div>

          {/* Prompt gets the full width — heading sits over the textarea
              instead of floating to its left, so the textarea can use the
              full row. */}
          <div>
            <h4 className="text-sm font-semibold mb-1">Prompt</h4>
            <textarea
              className="textarea border-base-300 w-full min-h-32 font-mono text-sm"
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              placeholder="What should the daemon do on each heartbeat tick?"
              aria-label="Heartbeat prompt"
            />
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Default model
// ---------------------------------------------------------------------------

/** Known model families. Claude Code accepts these short aliases directly
 *  (verified by the agentic modes in src/config.ts), and they auto-track
 *  the latest version so users don't have to pin SKUs. */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku"] as const;
type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** Match a saved model value to a family if it's a known alias or contains
 *  one (e.g. `claude-opus-4-7` → `opus`). Otherwise null = custom. */
function detectFamily(value: string): ModelFamily | null {
  const v = value.trim().toLowerCase();
  if (!v) {
    return null;
  }
  for (const f of MODEL_FAMILIES) {
    if (v === f || v.includes(f)) {
      return f;
    }
  }
  return null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tab-level panel; pieces are factored into FamilyRow + detectFamily.
function ModelPanel() {
  const state = useAsync<StateResponse>(() => getState());
  const [model, setModel] = useState("");
  const [fallback, setFallback] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [seenState, setSeenState] = useState<unknown>(null);

  if (state.data && state.data !== seenState) {
    setSeenState(state.data);
    setModel(state.data.model ?? "");
    const f = state.data.fallback;
    setFallback(typeof f === "string" ? f : (f?.model ?? ""));
    // Open the advanced field automatically if either saved value isn't a
    // recognized family alias — the user has pinned something specific.
    const savedModel = state.data.model ?? "";
    const savedFallback = typeof f === "string" ? f : (f?.model ?? "");
    if (
      (savedModel && detectFamily(savedModel) === null) ||
      (savedFallback && detectFamily(savedFallback) === null)
    ) {
      setAdvanced(true);
    }
  }

  const { status, error: err } = useAutosave(
    { model, fallback },
    async (next) => {
      await updateSettings(next);
      state.reload();
    },
    { enabled: state.data !== null },
  );

  return (
    <Card actions={<SaveStatus status={status} />}>
      {state.loading && <Loader />}
      {state.error ? <ErrorBanner error={state.error} /> : null}
      {err ? <ErrorBanner error={err} /> : null}
      <div className="space-y-4">
        <FamilyRow
          label="Primary"
          help="Used for new chats and routines unless the job overrides it."
          value={model}
          onChange={setModel}
        />
        <FamilyRow
          label="Fallback"
          help="Used when the primary model is rate-limited."
          value={fallback}
          onChange={setFallback}
        />

        <div>
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            className="inline-flex items-center gap-1 text-sm font-medium text-base-content/80 hover:text-base-content"
            aria-expanded={advanced}
          >
            <span className={`transition-transform ${advanced ? "rotate-90" : ""}`}>›</span>
            Advanced
          </button>
          {advanced && (
            <div className="space-y-3 mt-2">
              <label className="form-control">
                <span className="label-text mb-1 text-xs">Primary (raw ID)</span>
                <input
                  type="text"
                  className="input border-base-300 input-sm font-mono"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="claude-opus-4-7"
                />
              </label>
              <label className="form-control">
                <span className="label-text mb-1 text-xs">Fallback (raw ID)</span>
                <input
                  type="text"
                  className="input border-base-300 input-sm font-mono"
                  value={fallback}
                  onChange={(e) => setFallback(e.target.value)}
                  placeholder="claude-sonnet-4-6"
                />
              </label>
              <p className="text-[11px] text-base-content/60">
                Pinning a specific SKU here locks the model — family aliases above auto-track the
                latest release.
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function GitIdentityPanel() {
  const state = useAsync<StateResponse>(() => getState());
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [seenState, setSeenState] = useState<unknown>(null);

  if (state.data && state.data !== seenState) {
    setSeenState(state.data);
    setName(state.data.git?.name ?? "");
    setEmail(state.data.git?.email ?? "");
  }

  const { status, error: err } = useAutosave(
    { name, email },
    async (next) => {
      await updateSettings({ git: next });
      state.reload();
    },
    { enabled: state.data !== null },
  );

  return (
    <Card actions={<SaveStatus status={status} />}>
      {state.loading && <Loader />}
      {state.error ? <ErrorBanner error={state.error} /> : null}
      {err ? <ErrorBanner error={err} /> : null}
      <p className="text-xs text-base-content/60 mb-2">
        Used as <code className="font-mono">user.name</code> and{" "}
        <code className="font-mono">user.email</code> when clawdcode commits to a jobs repo.
        Required in containerized deployments where the global git config is empty.
      </p>
      <div className="space-y-3">
        <label className="form-control">
          <span className="label-text mb-1 text-xs">Name</span>
          <input
            type="text"
            className="input border-base-300 input-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Clawdcode Bot"
          />
        </label>
        <label className="form-control">
          <span className="label-text mb-1 text-xs">Email</span>
          <input
            type="email"
            className="input border-base-300 input-sm font-mono"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="bot@example.com"
          />
        </label>
      </div>
    </Card>
  );
}

function FamilyRow({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const family = detectFamily(value);
  const isCustom = value.trim().length > 0 && family === null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="label-text font-medium">{label}</span>
        {isCustom && (
          <span
            className="text-[11px] font-mono text-base-content/60 truncate max-w-[60%]"
            title={value}
          >
            custom · {value}
          </span>
        )}
      </div>
      <p className="text-xs text-base-content/60 mb-2">{help}</p>
      <div role="radiogroup" className="join">
        {MODEL_FAMILIES.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={family === f}
            onClick={() => onChange(f)}
            className={`btn btn-sm join-item capitalize ${family === f ? "btn-primary" : ""}`}
          >
            {f}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={value.trim().length === 0}
          onClick={() => onChange("")}
          className={`btn btn-sm join-item ${value.trim().length === 0 ? "btn-primary" : ""}`}
          title="Inherit from Claude Code defaults"
        >
          default
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function AppearancePanel() {
  const { mode, lightTheme, darkTheme } = useThemeState();

  return (
    <Card>
      <div className="space-y-6">
        <section>
          <h4 className="text-sm font-semibold mb-2">Mode</h4>
          <p className="text-sm text-base-content/70 mb-3">
            "System" follows your OS light/dark preference.
          </p>
          <div role="radiogroup" className="join">
            {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={`btn join-item btn-sm capitalize ${mode === m ? "btn-primary" : ""}`}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h4 className="text-sm font-semibold mb-2">Light theme</h4>
          <p className="text-sm text-base-content/70 mb-3">
            Used when mode is Light, or when System reports a light OS preference.
          </p>
          <ThemeGrid options={LIGHT_THEMES} active={lightTheme} onSelect={setLightTheme} />
        </section>

        <section>
          <h4 className="text-sm font-semibold mb-2">Dark theme</h4>
          <p className="text-sm text-base-content/70 mb-3">
            Used when mode is Dark, or when System reports a dark OS preference.
          </p>
          <ThemeGrid options={DARK_THEMES} active={darkTheme} onSelect={setDarkTheme} />
        </section>
      </div>
    </Card>
  );
}

function ThemeGrid({
  options,
  active,
  onSelect,
}: {
  options: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {options.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-pressed={active === t.id}
          onClick={() => onSelect(t.id)}
          data-theme={t.id}
          className={`rounded-box border p-2 text-left transition bg-base-100 text-base-content hover:scale-[1.01] ${
            active === t.id ? "border-primary ring-2 ring-primary" : "border-base-300"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium truncate">{t.label}</span>
            {active === t.id && <span className="badge badge-primary badge-xs">active</span>}
          </div>
          <div className="flex gap-1">
            <span className="size-4 rounded bg-primary" />
            <span className="size-4 rounded bg-secondary" />
            <span className="size-4 rounded bg-accent" />
            <span className="size-4 rounded bg-neutral" />
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhook receiver panel — moved here from the (retired) Hooks tab. Shows
// the inbound webhook URL, the HMAC secret (if configured), and a curl
// snippet for manual test deliveries. Per the new IA, hook *setup* belongs
// in Settings; live data (triggers, deliveries) moved into the Runs page.

function WebhookReceiverPanel() {
  const status = useAsync(() => import("../../api/hooks").then((m) => m.getReceiverStatus()));
  return (
    <Card>
      {status.loading && <Loader />}
      {status.error ? <ErrorBanner error={status.error} /> : null}
      {status.data && <ReceiverCard status={status.data} />}
    </Card>
  );
}
