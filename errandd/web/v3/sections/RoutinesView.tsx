import {
  Bug,
  CalendarClock,
  CircleDot,
  Eye,
  GitPullRequest,
  LineChart,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Ticket,
  Trash2,
  UploadCloud,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  createJobFile,
  getJobFile,
  type JobFileEntry,
  listJobFiles,
  writeJobFile,
} from "../../api/jobs";
import { listRepos, pullRepo, type RepoStatus, syncRepo } from "../../api/repos";
import { MarkdownView } from "../../ui/components/MarkdownView";
import {
  ChecksHookEditor,
  DatadogHookEditor,
  IssuesHookEditor,
  LinearHookEditor,
  SentryHookEditor,
} from "../../ui/components/ProviderHookEditor";
import { RoutineEditor } from "../../ui/components/RoutineEditor";
import { ScheduleEditor } from "../../ui/components/ScheduleEditor";
import { ScheduleReadout } from "../../ui/components/ScheduleReadout";
// Reuse the existing routine editor + schedule helpers + readout + the leaf
// schedule / provider hook editors from web/ui — they depend only on
// web/api/* + darwin-ui, so they render unchanged in v3. The GitHub portion is
// replaced by the v3-native GitHubTriggersPanel (the clear 2×2 matrix).
import {
  defaultChecksRule,
  defaultDatadogRule,
  defaultIssuesRule,
  defaultLinearRule,
  defaultSentryRule,
  type HookConfig,
} from "../../ui/hookConfig";
import { type JobFrontmatter, readFrontmatter, writeFrontmatter } from "../../ui/schedule";
import { useAsync } from "../../ui/useAsync";
import type { MainPaneProps } from "../App";
import { GitHubTriggersPanel } from "../components/GitHubTriggersPanel";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/utils";

/**
 * v3 Routines — markdown routine editor + git sync (spec §9).
 *
 * Reuses the existing `/api/jobs/file*` CRUD + `/api/jobs/repos/:slug/{pull,sync}`
 * wiring and the `RoutineEditor` / `MarkdownView` / `ScheduleReadout` /
 * `TriggersEditor` components from the web/ui JobsSection, rebuilt inside the
 * v3 shell. Navigation is **local state** (selected repo + file) rather than
 * the web/ui hash router, so it doesn't collide with v3's own `#/` router.
 */
export function RoutinesView(_props: MainPaneProps) {
  const repos = useAsync<RepoStatus[]>(() => listRepos());
  const [slug, setSlug] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);

  // Default to the first repo once it loads.
  const activeSlug = slug ?? repos.data?.[0]?.slug ?? null;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <header className="shrink-0 px-4 py-3 border-b border-base-300 flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Errands</h1>
        {repos.data && repos.data.length > 1 && (
          <div role="tablist" className="flex flex-wrap gap-1 ml-2">
            {repos.data.map((r) => (
              <button
                key={r.slug}
                role="tab"
                type="button"
                aria-selected={r.slug === activeSlug}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  r.slug === activeSlug
                    ? "bg-primary text-primary-content"
                    : "text-base-content/70 hover:bg-base-200",
                )}
                onClick={() => {
                  setSlug(r.slug);
                  setFile(null);
                }}
              >
                {r.slug}
                {r.dirty && <span className="ml-1.5 badge badge-warning badge-xs">dirty</span>}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-4 space-y-4">
          {repos.loading && <div className="text-sm text-base-content/60">Loading sources…</div>}
          {repos.error != null && <ErrorBanner error={repos.error} />}
          {repos.data?.length === 0 && (
            <div className="rounded-lg border border-base-300 bg-base-100 p-4 text-sm text-base-content/60">
              No sources configured yet. Add one in Settings → Sources.
            </div>
          )}
          {activeSlug && !file && (
            <RepoView
              slug={activeSlug}
              repo={repos.data?.find((r) => r.slug === activeSlug)}
              onReloadRepos={repos.reload}
              onOpenFile={setFile}
            />
          )}
          {activeSlug && file && (
            <FileView slug={activeSlug} file={file} onBack={() => setFile(null)} />
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-error/40 bg-error/10 px-4 py-2 text-sm text-error">
      {msg}
    </div>
  );
}

function RepoView({
  slug,
  repo,
  onReloadRepos,
  onOpenFile,
}: {
  slug: string;
  repo: RepoStatus | undefined;
  onReloadRepos: () => void;
  onOpenFile: (path: string) => void;
}) {
  const files = useAsync<JobFileEntry[]>(() => listJobFiles(slug), slug);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<unknown>(null);

  async function onSync() {
    setBusy(true);
    setOpError(null);
    try {
      // Sync = pull + commit/push so a single button keeps local + remote in
      // agreement (same semantics as the web/ui JobsSection).
      await pullRepo(slug);
      await syncRepo(slug);
      onReloadRepos();
      files.reload();
    } catch (e) {
      setOpError(e);
    } finally {
      setBusy(false);
    }
  }

  async function onAddRoutine() {
    const name = window.prompt("New routine filename (without .md):");
    if (!name) {
      return;
    }
    const path = name.endsWith(".md") ? name : `${name}.md`;
    try {
      await createJobFile(path, slug);
      files.reload();
      onOpenFile(path);
    } catch (e) {
      setOpError(e);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {repo && <RepoMeta repo={repo} />}
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={() => void onSync()} disabled={busy}>
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
            {busy ? "Syncing…" : "Sync"}
          </Button>
          <Button size="sm" onClick={() => void onAddRoutine()}>
            <Plus className="size-4" /> Add routine
          </Button>
        </div>
      </div>

      {opError != null && <ErrorBanner error={opError} />}

      {repo && !repo.cloned ? (
        <Card title="Routines">
          <div className="text-sm text-base-content/60">
            Not cloned yet. Click Sync above to fetch this repo.
          </div>
        </Card>
      ) : (
        <>
          <Card title="Routines">
            {files.loading && <div className="text-sm text-base-content/60">Loading…</div>}
            {files.error != null && <ErrorBanner error={files.error} />}
            {files.data && <RoutinesList files={files.data} onOpenFile={onOpenFile} />}
          </Card>
          {files.data && <FilesCard files={files.data} onOpenFile={onOpenFile} />}
        </>
      )}
    </>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-base-300 bg-base-100 p-4">
      {title && <h2 className="mb-2 text-sm font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

function RepoMeta({ repo }: { repo: RepoStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/70">
      <span className="badge badge-outline">{repo.branch}</span>
      {repo.ahead > 0 && <span className="badge badge-info">↑ {repo.ahead}</span>}
      {repo.behind > 0 && <span className="badge badge-warning">↓ {repo.behind}</span>}
      {repo.dirty && <span className="badge badge-warning">dirty</span>}
      {!repo.cloned && <span className="badge badge-error">not cloned</span>}
    </div>
  );
}

function RoutinesList({
  files,
  onOpenFile,
}: {
  files: JobFileEntry[];
  onOpenFile: (path: string) => void;
}) {
  const routines = files.filter((f) => f.isJob);
  if (routines.length === 0) {
    return <div className="text-sm text-base-content/60">No routines yet. Add one above.</div>;
  }
  return (
    <ul className="divide-y divide-base-300 -mx-4">
      {routines.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            className="w-full text-left px-4 py-2 hover:bg-base-200 flex items-center justify-between gap-2"
            onClick={() => onOpenFile(f.path)}
          >
            <span className="font-mono text-sm truncate">{f.path}</span>
            <span className="badge badge-ghost badge-sm">job</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface TreeNode {
  name: string;
  fullPath?: string;
  children: Map<string, TreeNode>;
}

function buildTree(files: JobFileEntry[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? "";
      let child = cursor.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        cursor.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.fullPath = f.path;
      }
      cursor = child;
    }
  }
  return root;
}

function FilesCard({
  files,
  onOpenFile,
}: {
  files: JobFileEntry[];
  onOpenFile: (path: string) => void;
}) {
  const others = files.filter((f) => !f.isJob);
  if (others.length === 0) {
    return null;
  }
  const tree = buildTree(others);
  return (
    <Card title="Files">
      <p className="text-xs text-base-content/60 -mt-1 mb-2">
        Reference material from this source — skills, commands, agents, memory, etc. Not scheduled
        by errandd.
      </p>
      <FileTree node={tree} onOpenFile={onOpenFile} />
    </Card>
  );
}

function FileTree({
  node,
  onOpenFile,
  depth = 0,
}: {
  node: TreeNode;
  onOpenFile: (path: string) => void;
  depth?: number;
}) {
  const entries = Array.from(node.children.values()).sort((a, b) => {
    const aDir = a.children.size > 0;
    const bDir = b.children.size > 0;
    if (aDir !== bDir) {
      return aDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return (
    <ul className={depth === 0 ? "space-y-0.5" : "space-y-0.5 pl-4 border-l border-base-300 ml-2"}>
      {entries.map((child) => {
        const isDir = child.children.size > 0;
        return (
          <li key={child.name}>
            {isDir ? (
              <details open={depth === 0}>
                <summary className="cursor-pointer text-sm font-mono text-base-content/80 hover:text-base-content py-0.5">
                  📁 {child.name}
                </summary>
                <FileTree node={child} onOpenFile={onOpenFile} depth={depth + 1} />
              </details>
            ) : (
              <button
                type="button"
                className="text-left text-sm font-mono text-base-content/70 hover:text-base-content py-0.5"
                onClick={() => child.fullPath && onOpenFile(child.fullPath)}
              >
                📄 {child.name}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FileView({ slug, file, onBack }: { slug: string; file: string; onBack: () => void }) {
  const initial = useAsync(() => getJobFile(file, slug), `${slug}/${file}`);
  const [draft, setDraft] = useState<string>("");
  const [saved, setSaved] = useState<string>("");
  const [seenData, setSeenData] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [tab, setTab] = useState<"edit" | "preview" | "config">("preview");

  // Adopt server content as the editor seed exactly once per fetch.
  if (initial.data && initial.data !== seenData) {
    setSeenData(initial.data);
    setDraft(initial.data.content);
    setSaved(initial.data.content);
  }

  const dirty = draft !== saved;

  async function onSave() {
    setSaving(true);
    setErr(null);
    try {
      await writeJobFile(file, draft, slug);
      setSaved(draft);
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  }

  async function onPush() {
    if (dirty) {
      await onSave();
    }
    setPushing(true);
    setErr(null);
    try {
      const result = await syncRepo(slug);
      if (!result.ok) {
        setErr(new Error(result.error ?? "sync failed"));
      }
    } catch (e) {
      setErr(e);
    } finally {
      setPushing(false);
    }
  }

  const fm = useMemo(() => readFrontmatter(draft), [draft]);

  return (
    <>
      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          className="text-base-content/60 hover:text-base-content"
          onClick={onBack}
        >
          ← {slug}
        </button>
        <span className="text-base-content/30">/</span>
        <span className="font-mono font-medium">{file}</span>
      </div>

      {initial.loading && <div className="text-sm text-base-content/60">Loading…</div>}
      {initial.error != null && <ErrorBanner error={initial.error} />}
      {err != null && <ErrorBanner error={err} />}

      {initial.data && <ScheduleReadout schedules={fm.schedules} hookConfig={fm.hookConfig} />}

      {initial.data && (
        <Card>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTab(tab === "edit" ? "preview" : "edit")}
              aria-label={tab === "edit" ? "Show preview" : "Edit source"}
            >
              {tab === "edit" ? (
                <>
                  <Eye className="size-3.5" /> Preview
                </>
              ) : (
                <>
                  <Pencil className="size-3.5" /> Edit
                </>
              )}
            </Button>
            <Button
              variant={tab === "config" ? "default" : "outline"}
              size="sm"
              aria-pressed={tab === "config"}
              onClick={() => setTab(tab === "config" ? "preview" : "config")}
            >
              <CalendarClock className="size-3.5" /> Config
            </Button>
            <div className="flex items-center gap-2 ml-auto">
              <Button variant="outline" size="sm" onClick={() => void onSave()} disabled={!dirty || saving}>
                <Save className="size-4" />
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" onClick={() => void onPush()} disabled={pushing}>
                <UploadCloud className="size-4" />
                {pushing ? "Pushing…" : "Save & push"}
              </Button>
            </div>
          </div>

          {tab === "edit" && <RoutineEditor value={draft} onChange={setDraft} />}
          {tab === "preview" && <MarkdownView source={draft} />}
          {tab === "config" && (
            <ConfigPane value={fm} onChange={(next) => setDraft(writeFrontmatter(draft, next))} />
          )}
        </Card>
      )}
    </>
  );
}

/** Config tab body: enabled toggle + v3-native Triggers layout + notify. Pure
 *  controlled — parent owns the JobFrontmatter draft (mirrors web/ui). The
 *  GitHub portion is the clear 2×2 GitHubTriggersPanel; schedule + Sentry +
 *  Datadog reuse the web/ui leaf editors. */
function ConfigPane({
  value,
  onChange,
}: {
  value: JobFrontmatter;
  onChange: (next: JobFrontmatter) => void;
}) {
  return (
    <div className="space-y-5">
      <section>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={value.enabled ?? true}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">Enabled</div>
            <div className="text-xs text-base-content/60">
              Off keeps the file but skips scheduling and hooks.
            </div>
          </div>
        </label>
      </section>

      <hr className="border-base-300" />

      <TriggersLayout value={value} onChange={onChange} />

      <hr className="border-base-300" />

      <section>
        <fieldset>
          <legend className="text-sm font-semibold mb-1">Notify on</legend>
          <div className="join">
            {(["true", "error", "false"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                aria-pressed={(value.notify ?? "false") === opt}
                onClick={() => onChange({ ...value, notify: opt })}
                className={cn(
                  "btn btn-sm join-item",
                  (value.notify ?? "false") === opt ? "btn-primary" : "btn-ghost",
                )}
              >
                {opt === "true" ? "Always" : opt === "error" ? "On error" : "Never"}
              </button>
            ))}
          </div>
        </fieldset>
      </section>
    </div>
  );
}

/**
 * v3-native triggers layout (spec §2.1). Replaces the monolithic web/ui
 * `TriggersEditor` inside the v3 Config tab with: schedules + recurring, the
 * clear GitHub 2×2 matrix (`GitHubTriggersPanel`), and the existing Sentry /
 * Datadog editors. All sections read/write the same `JobFrontmatter.hookConfig`
 * via merge discipline so they never clobber each other.
 */
function TriggersLayout({
  value,
  onChange,
}: {
  value: JobFrontmatter;
  onChange: (next: JobFrontmatter) => void;
}) {
  const cfg = value.hookConfig;
  const schedules = value.schedules;
  const scheduleActive = schedules.length > 0;
  const sentryActive = cfg?.sentry !== undefined && cfg?.sentry !== false;
  const datadogActive = cfg?.datadog !== undefined && cfg?.datadog !== false;
  const checksActive = cfg?.checks !== undefined && cfg?.checks !== false;
  const issuesActive = cfg?.issues !== undefined && cfg?.issues !== false;
  const linearActive = cfg?.linear !== undefined && cfg?.linear !== false;

  function addSchedule() {
    onChange({ ...value, schedules: [...schedules, "*/5 * * * *"] });
  }
  function updateScheduleAt(i: number, cron: string) {
    const next = schedules.slice();
    next[i] = cron;
    onChange({ ...value, schedules: next });
  }
  function removeScheduleAt(i: number) {
    const next = schedules.filter((_, j) => j !== i);
    onChange({ ...value, schedules: next, recurring: next.length > 0 ? value.recurring : null });
  }

  /** Mutate a draft HookConfig then persist — dropping the block when no
   *  trigger remains (mirrors web/ui TriggersEditor.mutateHookConfig). */
  function mutateHookConfig(fn: (draft: HookConfig) => void) {
    const draft: HookConfig = cfg ? { ...cfg, pr: [...cfg.pr] } : { skipSelf: true, pr: [] };
    fn(draft);
    const commentsActive =
      draft.comments === true || (typeof draft.comments === "object" && draft.comments !== null);
    const anyTrigger =
      draft.pr.length > 0 ||
      commentsActive ||
      (draft.sentry !== undefined && draft.sentry !== false) ||
      (draft.datadog !== undefined && draft.datadog !== false) ||
      (draft.linear !== undefined && draft.linear !== false) ||
      (draft.checks !== undefined && draft.checks !== false) ||
      (draft.issues !== undefined && draft.issues !== false);
    onChange({ ...value, hookConfig: anyTrigger ? draft : null });
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold mr-1">Triggers</h3>
        <Button variant="outline" size="sm" onClick={addSchedule}>
          <Plus className="size-3.5" /> schedule
        </Button>
        {!sentryActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              mutateHookConfig((d) => {
                d.sentry = defaultSentryRule();
              })
            }
          >
            <Plus className="size-3.5" /> sentry hook
          </Button>
        )}
        {!datadogActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              mutateHookConfig((d) => {
                d.datadog = defaultDatadogRule();
              })
            }
          >
            <Plus className="size-3.5" /> dd hook
          </Button>
        )}
        {!checksActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              mutateHookConfig((d) => {
                d.checks = defaultChecksRule();
              })
            }
          >
            <Plus className="size-3.5" /> checks hook
          </Button>
        )}
        {!issuesActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              mutateHookConfig((d) => {
                d.issues = defaultIssuesRule();
              })
            }
          >
            <Plus className="size-3.5" /> issues hook
          </Button>
        )}
        {!linearActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              mutateHookConfig((d) => {
                d.linear = defaultLinearRule();
              })
            }
          >
            <Plus className="size-3.5" /> linear hook
          </Button>
        )}
      </div>

      {schedules.map((cron, i) => (
        <TriggerCard
          // biome-ignore lint/suspicious/noArrayIndexKey: schedules are positional with no stable id.
          key={`schedule-${i}`}
          icon={<CalendarClock size={14} className="opacity-70" />}
          label={schedules.length > 1 ? `Schedule ${i + 1}` : "Schedule"}
          onRemove={() => removeScheduleAt(i)}
        >
          <ScheduleEditor cron={cron} onChange={(next) => updateScheduleAt(i, next)} />
        </TriggerCard>
      ))}

      {scheduleActive && (
        <label className="flex items-center gap-3 cursor-pointer px-1">
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={value.recurring ?? false}
            onChange={(e) => onChange({ ...value, recurring: e.target.checked })}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">Recurring</div>
            <div className="text-xs text-base-content/60">
              Re-arm after each run instead of firing once. Applies to all schedules.
            </div>
          </div>
        </label>
      )}

      {/* GitHub — the clear 2×2 matrix. Always shown (easy defaults seed a new
          routine the moment a box is ticked). */}
      <div className="rounded-lg border border-base-300 bg-base-100 p-4">
        <div className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold">
          <GitPullRequest size={14} className="opacity-70" /> GitHub
        </div>
        <GitHubTriggersPanel value={value} onChange={onChange} />
      </div>

      {sentryActive && cfg?.sentry !== undefined && (
        <TriggerCard
          icon={<Bug size={14} className="opacity-70" />}
          label="Sentry hooks"
          onRemove={() =>
            mutateHookConfig((d) => {
              delete d.sentry;
            })
          }
        >
          <SentryHookEditor
            value={cfg.sentry}
            onChange={(next) =>
              mutateHookConfig((d) => {
                d.sentry = next;
              })
            }
          />
        </TriggerCard>
      )}

      {datadogActive && cfg?.datadog !== undefined && (
        <TriggerCard
          icon={<LineChart size={14} className="opacity-70" />}
          label="Datadog hooks"
          onRemove={() =>
            mutateHookConfig((d) => {
              delete d.datadog;
            })
          }
        >
          <DatadogHookEditor
            value={cfg.datadog}
            onChange={(next) =>
              mutateHookConfig((d) => {
                d.datadog = next;
              })
            }
          />
        </TriggerCard>
      )}

      {checksActive && cfg?.checks !== undefined && (
        <TriggerCard
          icon={<ListChecks size={14} className="opacity-70" />}
          label="CI / checks hooks"
          onRemove={() =>
            mutateHookConfig((d) => {
              delete d.checks;
            })
          }
        >
          <ChecksHookEditor
            value={cfg.checks}
            onChange={(next) =>
              mutateHookConfig((d) => {
                d.checks = next;
              })
            }
          />
        </TriggerCard>
      )}

      {issuesActive && cfg?.issues !== undefined && (
        <TriggerCard
          icon={<CircleDot size={14} className="opacity-70" />}
          label="Issues hooks"
          onRemove={() =>
            mutateHookConfig((d) => {
              delete d.issues;
            })
          }
        >
          <IssuesHookEditor
            value={cfg.issues}
            onChange={(next) =>
              mutateHookConfig((d) => {
                d.issues = next;
              })
            }
          />
        </TriggerCard>
      )}

      {linearActive && cfg?.linear !== undefined && (
        <TriggerCard
          icon={<Ticket size={14} className="opacity-70" />}
          label="Linear hooks"
          onRemove={() =>
            mutateHookConfig((d) => {
              delete d.linear;
            })
          }
        >
          <LinearHookEditor
            value={cfg.linear}
            onChange={(next) =>
              mutateHookConfig((d) => {
                d.linear = next;
              })
            }
          />
        </TriggerCard>
      )}
    </section>
  );
}

function TriggerCard({
  icon,
  label,
  onRemove,
  children,
}: {
  icon: ReactNode;
  label: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-base-300 bg-base-100 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
          {icon}
          {label}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {children}
    </section>
  );
}
