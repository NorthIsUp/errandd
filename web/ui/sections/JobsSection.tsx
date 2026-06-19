import {
  ArrowUpRight,
  CalendarClock,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  UploadCloud,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createJobFile,
  getJobFile,
  type JobFileEntry,
  listJobFiles,
  writeJobFile,
} from "../../api/jobs";
import { listRepos, pullRepo, type RepoStatus, syncRepo } from "../../api/repos";
import { listSessions, type SessionInfo } from "../../api/sessions";
import { Card } from "../components/Card";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { MarkdownView } from "../components/MarkdownView";
import { RoutineEditor } from "../components/RoutineEditor";
import { PageHeader } from "../components/PageHeader";
import { ScheduleReadout } from "../components/ScheduleReadout";
import { TriggersEditor } from "../components/TriggersEditor";
import { type TabId, useRoute } from "../router";
import { type JobFrontmatter, readFrontmatter, writeFrontmatter } from "../schedule";
import { useAsync } from "../useAsync";

export function JobsSection() {
  const { route, goto } = useRoute();
  const [slug, file] = route.segments;

  if (!slug) {
    return <ReposIndex />;
  }
  if (slug && !file) {
    return <RepoView slug={slug} />;
  }
  if (slug && file) {
    return <FileView slug={slug} file={file} back={() => goto("jobs", [slug])} />;
  }
  return null;
}

function ReposIndex() {
  const { goto } = useRoute();
  const repos = useAsync<RepoStatus[]>(() => listRepos());

  // Auto-select the first repo so the Jobs page never lands on a bare picker.
  useEffect(() => {
    const first = repos.data?.[0];
    if (first) {
      goto("jobs", [first.slug]);
    }
  }, [repos.data, goto]);

  return (
    <>
      <PageHeader
        title="Jobs"
        crumbs={[{ label: "Jobs" }]}
        actions={
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => goto("settings", ["sources"])}
          >
            <Plus size={16} /> Add source
          </button>
        }
      />
      {repos.loading && <Loader />}
      {repos.error ? <ErrorBanner error={repos.error} /> : null}
      {repos.data?.length === 0 && (
        <Card>
          <Empty>No sources configured yet. Add one in Settings → Sources.</Empty>
        </Card>
      )}
      {repos.data && repos.data.length > 0 && <Loader label="Opening repo…" />}
    </>
  );
}

function RepoView({ slug }: { slug: string }) {
  const { goto } = useRoute();
  const repos = useAsync<RepoStatus[]>(() => listRepos());
  const files = useAsync<JobFileEntry[]>(() => listJobFiles(slug), slug);
  const repo = repos.data?.find((r) => r.slug === slug);
  const [busy, setBusy] = useState<"sync" | "pull" | null>(null);
  const [opError, setOpError] = useState<unknown>(null);

  async function onSync() {
    setBusy("sync");
    setOpError(null);
    try {
      // Sync = pull + commit/push so a single button keeps the local clone
      // and the remote in agreement.
      await pullRepo(slug);
      await syncRepo(slug);
      repos.reload();
      files.reload();
    } catch (e) {
      setOpError(e);
    } finally {
      setBusy(null);
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
      goto("jobs", [slug, path]);
    } catch (e) {
      setOpError(e);
    }
  }

  return (
    <>
      <PageHeader
        title={slug}
        crumbs={[{ label: "Jobs", onClick: () => goto("jobs") }, { label: slug }]}
      />

      {repos.data && repos.data.length > 1 && (
        <div
          role="tablist"
          // tabs-lift: active tab merges with the content below by removing
          // its own bottom border. We give the routines container a flush
          // top border so the seam is invisible — that's the visual fix
          // for "tabs disjoint from contents".
          className="tabs tabs-lift mb-0"
        >
          {repos.data.map((r) => (
            <button
              key={r.slug}
              role="tab"
              type="button"
              aria-selected={r.slug === slug}
              className={`tab ${r.slug === slug ? "tab-active" : ""}`}
              onClick={() => goto("jobs", [r.slug])}
            >
              {r.slug}
              {r.dirty && <span className="ml-2 badge badge-warning badge-xs">dirty</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {repo && <RepoMeta repo={repo} />}
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          <button type="button" className="btn btn-sm" onClick={() => void onSync()} disabled={busy !== null}>
            <RefreshCw size={16} className={busy === "sync" ? "animate-spin" : ""} />
            {busy === "sync" ? "Syncing…" : "Sync"}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void onAddRoutine()}>
            <Plus size={16} /> Add routine
          </button>
        </div>
      </div>

      {opError && <ErrorBanner error={opError} />}

      {/* Split routines (cron-scheduled .md) from other files (skills,
          commands, agents, memory dumps, READMEs). The former is the
          actual subject of this tab; the latter is reference material
          shown as a tree below. */}
      {repo && !repo.cloned ? (
        <Card title="Routines">
          <Empty>Not cloned yet. Click Sync above to fetch this repo.</Empty>
        </Card>
      ) : (
        <>
          <Card title="Routines">
            {files.loading && <Loader />}
            {files.error ? <ErrorBanner error={files.error} /> : null}
            {files.data && <RoutinesList files={files.data} slug={slug} goto={goto} />}
          </Card>
          {files.data && <FilesCard files={files.data} slug={slug} goto={goto} />}
        </>
      )}
    </>
  );
}

function RoutinesList({
  files,
  slug,
  goto,
}: {
  files: JobFileEntry[];
  slug: string;
  goto: (tab: TabId, segments?: string[]) => void;
}) {
  const routines = files.filter((f) => f.isJob);
  if (routines.length === 0) {
    return <Empty>No routines yet. Add one above.</Empty>;
  }
  return (
    <ul className="divide-y divide-base-300 -mx-4">
      {routines.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            className="w-full text-left px-4 py-2 hover:bg-base-200 flex items-center justify-between gap-2"
            onClick={() => goto("jobs", [slug, f.path])}
          >
            <span className="font-mono text-sm truncate">{f.path}</span>
            <span className="badge badge-ghost badge-sm">job</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function FilesCard({
  files,
  slug,
  goto,
}: {
  files: JobFileEntry[];
  slug: string;
  goto: (tab: TabId, segments?: string[]) => void;
}) {
  const others = files.filter((f) => !f.isJob);
  if (others.length === 0) return null;
  const tree = buildTree(others);
  return (
    <Card title="Files">
      <p className="text-xs text-base-content/60 -mt-1 mb-2">
        Reference material from this source — skills, commands, agents, memory, etc.
        Not scheduled by clawdcode.
      </p>
      <FileTree node={tree} slug={slug} goto={goto} />
    </Card>
  );
}

interface TreeNode {
  name: string;
  fullPath?: string; // set on leaf nodes
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

function FileTree({
  node,
  slug,
  goto,
  depth = 0,
}: {
  node: TreeNode;
  slug: string;
  goto: (tab: TabId, segments?: string[]) => void;
  depth?: number;
}) {
  // Sort directories first, then files; both alpha within each group.
  const entries = Array.from(node.children.values()).sort((a, b) => {
    const aDir = a.children.size > 0;
    const bDir = b.children.size > 0;
    if (aDir !== bDir) return aDir ? -1 : 1;
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
                <FileTree node={child} slug={slug} goto={goto} depth={depth + 1} />
              </details>
            ) : (
              <button
                type="button"
                className="text-left text-sm font-mono text-base-content/70 hover:text-base-content py-0.5"
                onClick={() => child.fullPath && goto("jobs", [slug, child.fullPath])}
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tab-level component composing schedule readout + editor tabs + chats; pieces are factored into ScheduleEditor / MarkdownView / ChatsForJob.
function FileView({ slug, file, back }: { slug: string; file: string; back: () => void }) {
  const { goto } = useRoute();
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
  const jobName = useMemo(() => file.replace(/\.md$/, ""), [file]);

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

  const previewFm = readFrontmatter(draft);

  return (
    <>
      <PageHeader
        title={file}
        crumbs={[
          { label: "Jobs", onClick: () => goto("jobs") },
          { label: slug, onClick: back },
        ]}
      />

      {initial.loading && <Loader />}
      {initial.error ? <ErrorBanner error={initial.error} /> : null}
      {err ? <ErrorBanner error={err} /> : null}

      {initial.data && (
        <ScheduleReadout schedules={previewFm.schedules} hookConfig={previewFm.hookConfig} />
      )}

      {initial.data && (
        <Card
          title={
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setTab(tab === "edit" ? "preview" : "edit")}
                aria-label={tab === "edit" ? "Show preview" : "Edit source"}
              >
                {tab === "edit" ? (
                  <>
                    <Eye size={14} /> Preview
                  </>
                ) : (
                  <>
                    <Pencil size={14} /> Edit
                  </>
                )}
              </button>
              <button
                type="button"
                aria-pressed={tab === "config"}
                onClick={() => setTab(tab === "config" ? "preview" : "config")}
                className={`btn btn-sm ${tab === "config" ? "btn-primary" : ""}`}
              >
                <CalendarClock size={14} /> Config
              </button>
            </div>
          }
          actions={
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void onSave()}
                disabled={!dirty || saving}
              >
                <Save size={16} />
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void onPush()}
                disabled={pushing}
              >
                <UploadCloud size={16} />
                {pushing ? "Pushing…" : "Save & push"}
              </button>
            </>
          }
        >
          {tab === "edit" && <RoutineEditor value={draft} onChange={setDraft} />}
          {tab === "preview" && <MarkdownView source={draft} />}
          {tab === "config" && (
            <ConfigPane
              value={readFrontmatter(draft)}
              onChange={(next) => setDraft(writeFrontmatter(draft, next))}
            />
          )}
        </Card>
      )}

      <ChatsForJob jobName={jobName} />
    </>
  );
}

/**
 * Config tab body: enabled toggle, unified Triggers editor, notify
 * setting. Pure controlled — parent owns the JobFrontmatter draft.
 */
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

      <TriggersEditor value={value} onChange={onChange} />

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
                className={`btn btn-sm join-item ${
                  (value.notify ?? "false") === opt ? "btn-primary" : "btn-ghost"
                }`}
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
 * Extract a human-friendly hook scope label from a session's firstMessage.
 *
 * Hook-fired runs are augmented in src/commands/start.ts:onHookFire with
 * a header like:
 *   "Triggered by GitHub issue_comment (delivery <id>) for scope `pr-42-feature-foo`:"
 *
 * Returns the scope key or null if the session isn't hook-driven (cron
 * runs and manual chats don't carry the header).
 */
function hookScopeFromFirstMessage(firstMessage: string | undefined): string | null {
  if (!firstMessage) return null;
  const m = /Triggered by GitHub (\S+).*? for scope `([^`]+)`/.exec(firstMessage);
  if (!m) return null;
  return m[2] ?? null;
}

function ChatsForJob({ jobName }: { jobName: string }) {
  const { goto } = useRoute();
  const sessions = useAsync<SessionInfo[]>(() => listSessions(true));
  const mine = useMemo(
    () => (sessions.data ?? []).filter((s) => s.jobName === jobName || s.title === jobName),
    [sessions.data, jobName],
  );

  return (
    <Card title="Recent chats">
      {sessions.loading && <Loader />}
      {sessions.error ? <ErrorBanner error={sessions.error} /> : null}
      {sessions.data && mine.length === 0 && <Empty>No chats linked to this routine yet.</Empty>}
      <ul className="divide-y divide-base-300 -mx-2">
        {mine.slice(0, 10).map((s) => {
          // For hook-driven jobs, the chat's identity is "which PR /
          // scope triggered me" — far more useful than a timestamp.
          // Falls back to the timestamp for cron / manual runs.
          const scope = hookScopeFromFirstMessage(s.firstMessage);
          const ts = new Date(s.lastUsedAt).toLocaleString();
          return (
            <li key={s.id} className="flex items-center gap-3 px-2 py-2 min-w-0">
              <div className="flex-1 min-w-0 flex items-baseline gap-3 flex-wrap">
                {scope ? (
                  <span
                    className="font-mono font-medium truncate"
                    title={`${scope} · ${ts}`}
                  >
                    {scope}
                  </span>
                ) : (
                  <time
                    className="font-medium tabular-nums"
                    dateTime={s.lastUsedAt}
                    title={ts}
                  >
                    {ts}
                  </time>
                )}
                <span className="text-xs text-base-content/60 tabular-nums">
                  {s.turnCount} turn{s.turnCount === 1 ? "" : "s"}
                </span>
                <span className="badge badge-ghost badge-xs">{s.channel}</span>
                {s.closed && <span className="badge badge-ghost badge-xs">closed</span>}
              </div>
              <button
                type="button"
                className="btn btn-sm btn-primary shrink-0"
                onClick={() => goto("chat", [s.id])}
                aria-label={`Open chat ${s.id}`}
              >
                <ArrowUpRight size={16} /> Open
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
