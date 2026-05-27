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
import { PageHeader } from "../components/PageHeader";
import { ScheduleEditor } from "../components/ScheduleEditor";
import { ScheduleReadout } from "../components/ScheduleReadout";
import { useRoute } from "../router";
import { readFrontmatter, writeFrontmatter } from "../schedule";
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
            onClick={() => goto("settings", ["repos"])}
          >
            <Plus size={16} /> Add repo
          </button>
        }
      />
      {repos.loading && <Loader />}
      {repos.error ? <ErrorBanner error={repos.error} /> : null}
      {repos.data && repos.data.length === 0 && (
        <Card>
          <Empty>No repos configured yet. Add one in Settings → Repos.</Empty>
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
        <div role="tablist" className="tabs tabs-lift">
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

      <div className="flex flex-wrap items-center gap-2">
        {repo && <RepoMeta repo={repo} />}
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          <button
            type="button"
            className="btn btn-sm"
            onClick={onSync}
            disabled={busy !== null}
          >
            <RefreshCw size={16} className={busy === "sync" ? "animate-spin" : ""} />
            {busy === "sync" ? "Syncing…" : "Sync"}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onAddRoutine}>
            <Plus size={16} /> Add routine
          </button>
        </div>
      </div>

      {opError && <ErrorBanner error={opError} />}

      <Card title="Routines">
        {files.loading && <Loader />}
        {files.error ? <ErrorBanner error={files.error} /> : null}
        {files.data && files.data.length === 0 && (
          <Empty>No .md routines yet. Add one above.</Empty>
        )}
        {files.data && files.data.length > 0 && (
          <ul className="divide-y divide-base-300 -mx-4">
            {files.data
              .filter((f) => f.path.endsWith(".md"))
              .map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className="w-full text-left px-4 py-2 hover:bg-base-200 flex items-center justify-between gap-2"
                    onClick={() => goto("jobs", [slug, f.path])}
                  >
                    <span className="font-mono text-sm truncate">{f.path}</span>
                    {f.isJob && <span className="badge badge-ghost badge-sm">job</span>}
                  </button>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </>
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
      await syncRepo(slug);
    } catch (e) {
      setErr(e);
    } finally {
      setPushing(false);
    }
  }

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

      {initial.data &&
        (() => {
          const fm = readFrontmatter(draft);
          return <ScheduleReadout cron={fm.schedule} hookConfig={fm.hookConfig} />;
        })()}

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
                onClick={onSave}
                disabled={!dirty || saving}
              >
                <Save size={16} />
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={onPush}
                disabled={pushing}
              >
                <UploadCloud size={16} />
                {pushing ? "Pushing…" : "Save & push"}
              </button>
            </>
          }
        >
          {tab === "edit" && (
            <textarea
              className="textarea textarea-bordered md-textarea w-full min-h-[24rem]"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
          )}
          {tab === "preview" && <MarkdownView source={draft} />}
          {tab === "config" && (
            <ScheduleEditor
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
        {mine.slice(0, 10).map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-2 py-2 min-w-0">
            <div className="flex-1 min-w-0 flex items-baseline gap-3 flex-wrap">
              <time
                className="font-medium tabular-nums"
                dateTime={s.lastUsedAt}
                title={new Date(s.lastUsedAt).toLocaleString()}
              >
                {new Date(s.lastUsedAt).toLocaleString()}
              </time>
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
        ))}
      </ul>
    </Card>
  );
}
