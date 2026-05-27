import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { listRepos, type RepoStatus } from "../../api/repos";
import {
  getHeartbeatSettings,
  type HeartbeatSettings,
  updateHeartbeatSettings,
  updateSettings,
} from "../../api/settings";
import type { StateResponse } from "../../api/state";
import { getState } from "../../api/state";
import { Card } from "../components/Card";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
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

export function SettingsSection() {
  const { route, goto } = useRoute();
  const sub = route.segments[0];

  return (
    <>
      <PageHeader
        title="Settings"
        crumbs={[
          { label: "Settings", onClick: sub ? () => goto("settings") : undefined },
          ...(sub ? [{ label: prettySub(sub) }] : []),
        ]}
      />

      {!sub && <Index />}
      {sub === "repos" && <ReposPanel />}
      {sub === "heartbeat" && <HeartbeatPanel />}
      {sub === "model" && <ModelPanel />}
      {sub === "appearance" && <AppearancePanel />}
    </>
  );
}

function prettySub(s: string): string {
  if (s === "repos") {
    return "Repos";
  }
  if (s === "heartbeat") {
    return "Heartbeat";
  }
  if (s === "model") {
    return "Default model";
  }
  if (s === "appearance") {
    return "Appearance";
  }
  return s;
}

function Index() {
  const { goto } = useRoute();
  const cards: { id: string; label: string; desc: string }[] = [
    { id: "repos", label: "Jobs repos", desc: "Git repos that supply routines." },
    {
      id: "heartbeat",
      label: "Heartbeat",
      desc: "Background tick that drives the daemon.",
    },
    {
      id: "model",
      label: "Default model",
      desc: "Model used for new chats and routines.",
    },
    {
      id: "appearance",
      label: "Appearance",
      desc: "Light/dark mode and theme picker.",
    },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {cards.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => goto("settings", [c.id])}
          className="card bg-base-100 border border-base-300 shadow-sm hover:bg-base-200 text-left"
        >
          <div className="card-body">
            <h3 className="card-title text-base">{c.label}</h3>
            <p className="text-sm text-base-content/70">{c.desc}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

interface RepoUrlEntry {
  id: number;
  url: string;
}
let repoEntrySeq = 0;

function ReposPanel() {
  const state = useAsync<StateResponse>(() => getState());
  const repos = useAsync<RepoStatus[]>(() => listRepos());
  const [urls, setUrls] = useState<RepoUrlEntry[]>([]);
  const [seenState, setSeenState] = useState<unknown>(null);

  if (state.data && state.data !== seenState) {
    setSeenState(state.data);
    setUrls(state.data.jobsRepos.map((r) => ({ id: ++repoEntrySeq, url: r.url })));
  }

  function update(id: number, v: string) {
    setUrls((u) => u.map((e) => (e.id === id ? { ...e, url: v } : e)));
  }
  function add() {
    setUrls((u) => [...u, { id: ++repoEntrySeq, url: "" }]);
  }
  function remove(id: number) {
    setUrls((u) => u.filter((e) => e.id !== id));
  }

  const { status, error: err } = useAutosave(
    urls,
    async (next) => {
      const cleaned = next.map((e) => e.url.trim()).filter(Boolean);
      const existing = state.data?.jobsRepos ?? [];
      const payload = cleaned.map((url) => {
        const found = existing.find((r) => r.url === url);
        return {
          url,
          branch: found?.branch ?? "main",
          intervalSeconds: found?.intervalSeconds ?? 300,
        };
      });
      await updateSettings({ jobsRepos: payload });
      state.reload();
      repos.reload();
    },
    { enabled: state.data !== null },
  );

  return (
    <Card
      title="Jobs repos"
      actions={
        <>
          <SaveStatus status={status} />
          <button type="button" className="btn btn-sm btn-primary" onClick={add}>
            <Plus size={16} /> Add repo
          </button>
        </>
      }
    >
      {state.loading && <Loader />}
      {state.error ? <ErrorBanner error={state.error} /> : null}
      {err ? <ErrorBanner error={err} /> : null}
      {urls.length === 0 && <Empty>No repos configured.</Empty>}
      <div className="space-y-2">
        {urls.map((entry, i) => (
          <div key={entry.id} className="join w-full">
            <input
              type="url"
              className="input input-bordered join-item flex-1 font-mono text-sm"
              value={entry.url}
              onChange={(e) => update(entry.id, e.target.value)}
              placeholder="git@github.com:org/repo.git"
              aria-label={`Repo ${i + 1} URL`}
            />
            <button
              type="button"
              className="btn btn-ghost join-item"
              onClick={() => remove(entry.id)}
              aria-label={`Remove repo ${i + 1}`}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
      {repos.data && repos.data.length > 0 && (
        <div className="mt-4 pt-4 border-t border-base-300">
          <h4 className="text-sm font-semibold mb-2">Current status</h4>
          <ul className="text-sm space-y-1">
            {repos.data.map((r) => (
              <li key={r.slug} className="flex items-center gap-2">
                <span className="font-mono">{r.slug}</span>
                <span className="text-base-content/60">{r.branch}</span>
                {r.dirty && <span className="badge badge-warning badge-xs">dirty</span>}
                {r.lastError && (
                  <span className="badge badge-error badge-xs" title={r.lastError}>
                    error
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
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
    <Card title="Heartbeat" actions={<SaveStatus status={status} />}>
      {hb.loading && <Loader />}
      {hb.error ? <ErrorBanner error={hb.error} /> : null}
      {err ? <ErrorBanner error={err} /> : null}
      {draft && (
        <div className="space-y-3">
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
            <span className="label-text mb-1">Interval (minutes)</span>
            <input
              type="number"
              min={1}
              className="input input-bordered w-32"
              value={Math.round(draft.interval / 60)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  interval: Math.max(60, Number(e.target.value) * 60),
                })
              }
            />
          </label>

          <label className="form-control">
            <span className="label-text mb-1">Prompt</span>
            <textarea
              className="textarea textarea-bordered min-h-24 font-mono text-sm"
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </label>
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
    <Card title="Default model" actions={<SaveStatus status={status} />}>
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
                  className="input input-bordered input-sm font-mono"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="claude-opus-4-7"
                />
              </label>
              <label className="form-control">
                <span className="label-text mb-1 text-xs">Fallback (raw ID)</span>
                <input
                  type="text"
                  className="input input-bordered input-sm font-mono"
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
    <Card title="Appearance">
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
