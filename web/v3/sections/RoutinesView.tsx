import { CalendarClock, Eye, Pencil, Plus, RefreshCw, Save, UploadCloud } from "lucide-react";
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
// Reuse the existing routine editor + schedule helpers + readout from web/ui —
// they depend only on web/api/* + darwin-ui, so they render unchanged in v3.
import { MarkdownView } from "../../ui/components/MarkdownView";
import { RoutineEditor } from "../../ui/components/RoutineEditor";
import { ScheduleReadout } from "../../ui/components/ScheduleReadout";
import { TriggersEditor } from "../../ui/components/TriggersEditor";
import { type JobFrontmatter, readFrontmatter, writeFrontmatter } from "../../ui/schedule";
import { useAsync } from "../../ui/useAsync";
import type { MainPaneProps } from "../App";
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
        <h1 className="text-lg font-semibold tracking-tight">Routines</h1>
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
          {repos.data && repos.data.length === 0 && (
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
          <Button variant="outline" size="sm" onClick={onSync} disabled={busy}>
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
            {busy ? "Syncing…" : "Sync"}
          </Button>
          <Button size="sm" onClick={onAddRoutine}>
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
        by clawdcode.
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
              <Button variant="outline" size="sm" onClick={onSave} disabled={!dirty || saving}>
                <Save className="size-4" />
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" onClick={onPush} disabled={pushing}>
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

/** Config tab body: enabled toggle + unified Triggers editor + notify. Pure
 *  controlled — parent owns the JobFrontmatter draft (mirrors web/ui). */
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
