import {
  Button,
  Checkbox,
  Dialog,
  FolderList,
  ListView,
  TabPanel,
  Tabs,
  TextField,
} from "@liiift-studio/mac-os9-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HomeResponse, LogRun } from "../../api/home";
import { getHome } from "../../api/home";
import {
  createJobFile,
  deleteJobFile,
  getJobFile,
  listJobFiles,
  writeJobFile,
  type JobFileEntry,
} from "../../api/jobs";
import { listRepos, type RepoStatus } from "../../api/repos";
import { Icon } from "../components/Icon";
import { MessageBubble } from "../components/MessageBubble";
import { Os9Scroll } from "../components/Os9Scroll";
import { useOs9Hash } from "../useOs9Hash";

interface FlatJob {
  source: string;
  repoSlug: string | null;
  path: string;
  name: string;
  /** Stable key used in URL hash for expand state. */
  key: string;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return (slash === -1 ? path : path.slice(slash + 1)).replace(/\.md$/, "");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

function extOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot + 1);
}

interface ParsedFm {
  enabled: boolean;
  schedule: string;
  recurring: boolean;
  notify: boolean;
}

function parseFm(content: string): { fm: ParsedFm; body: string } {
  const empty: ParsedFm = {
    enabled: true,
    schedule: "",
    recurring: false,
    notify: true,
  };
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { fm: empty, body: content };
  const raw = match[1] ?? "";
  const body = match[2] ?? "";
  const fm: ParsedFm = { ...empty };
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const val = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "enabled") fm.enabled = !/^(false|no|0|off)$/i.test(val);
    else if (key === "schedule") fm.schedule = val;
    else if (key === "recurring") fm.recurring = /^(true|yes|1|on)$/i.test(val);
    else if (key === "notify" || key === "notification")
      fm.notify = !/^(false|no|0|off)$/i.test(val);
  }
  return { fm, body };
}

function serializeFm(fm: ParsedFm, body: string): string {
  const lines = [
    "---",
    `enabled: ${fm.enabled}`,
    fm.schedule ? `schedule: "${fm.schedule}"` : "",
    `recurring: ${fm.recurring}`,
    `notify: ${fm.notify}`,
    "---",
    "",
  ].filter(Boolean);
  return `${lines.join("\n")}\n${body.replace(/^\n+/, "")}`;
}

// Indent and disclosure prefix go in the name column. Three NBSPs ≈ one level.
const INDENT = "   ";
const NBSP_GAP = " ";

function namePrefix(depth: number, disclosure: "▷" | "▽" | null): string {
  return `${INDENT.repeat(depth)}${disclosure ?? " "}${NBSP_GAP}`;
}

interface RowMeta {
  /** Item id form: "routine:<key>" | "md:<key>" | "runs:<key>" | "run:<key>:<idx>" */
  kind: "routine" | "md" | "runs" | "run";
  jobKey: string;
  runIdx?: number;
}

interface SectionProps {
  maxHeight: number;
}

export function RoutinesSection({ maxHeight }: SectionProps) {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [local, setLocal] = useState<JobFileEntry[]>([]);
  const [repoFiles, setRepoFiles] = useState<Record<string, JobFileEntry[]>>({});
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FlatJob | null>(null);
  const [viewingRun, setViewingRun] = useState<LogRun | null>(null);
  const { params, setParam } = useOs9Hash();

  const reload = useCallback(async () => {
    try {
      const [r, lf, h] = await Promise.all([
        listRepos().catch(() => [] as RepoStatus[]),
        listJobFiles(null).catch(() => [] as JobFileEntry[]),
        getHome().catch(() => null),
      ]);
      setRepos(r);
      setLocal(lf);
      setHome(h);
      const per: Record<string, JobFileEntry[]> = {};
      await Promise.all(
        r.map(async (repo) => {
          if (!repo.cloned) return;
          try {
            per[repo.slug] = await listJobFiles(repo.slug);
          } catch {
            per[repo.slug] = [];
          }
        }),
      );
      setRepoFiles(per);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  interface JobGroup {
    id: string;
    title: string;
    jobs: FlatJob[];
  }

  const groups: JobGroup[] = useMemo(() => {
    const out: JobGroup[] = [];

    // Collect every path claimed by a repo (any plugin or orphan), then add
    // "Local" only for files that aren't already in a repo. The server's
    // null-repo endpoint falls back to repo[0] for back-compat, so the raw
    // local list otherwise duplicates the first repo's jobs.
    const repoPaths = new Set<string>();
    for (const repo of repos) {
      for (const f of repoFiles[repo.slug] ?? []) {
        if (f.isJob) repoPaths.add(f.path);
      }
    }
    const localJobs: FlatJob[] = local
      .filter((f) => f.isJob && !repoPaths.has(f.path))
      .map((f, i) => ({
        source: "Local",
        repoSlug: null,
        path: f.path,
        name: baseName(f.path),
        key: `local:${i}`,
      }));
    if (localJobs.length > 0) {
      out.push({ id: "local", title: "Local", jobs: localJobs });
    }

    // One group per plugin (per repo). Jobs under a plugin's dir belong to it.
    for (const repo of repos) {
      const files = (repoFiles[repo.slug] ?? []).filter((f) => f.isJob);
      const claimed = new Set<string>();
      for (let pi = 0; pi < repo.plugins.length; pi++) {
        const plugin = repo.plugins[pi];
        if (!plugin) continue;
        const dir = plugin.dir.endsWith("/") ? plugin.dir : `${plugin.dir}/`;
        const pluginJobs: FlatJob[] = files
          .filter((f) => f.path.startsWith(dir))
          .map((f, i) => {
            claimed.add(f.path);
            return {
              source: `${repo.slug} / ${plugin.name}`,
              repoSlug: repo.slug,
              path: f.path,
              name: baseName(f.path),
              key: `${repo.slug}:${plugin.name}:${i}`,
            };
          });
        out.push({
          id: `${repo.slug}:${plugin.name}`,
          title: `${repo.slug} / ${plugin.name}`,
          jobs: pluginJobs,
        });
      }
      // Anything not under a plugin dir — show as "<repo> (other)".
      const orphans: FlatJob[] = files
        .filter((f) => !claimed.has(f.path))
        .map((f, i) => ({
          source: repo.slug,
          repoSlug: repo.slug,
          path: f.path,
          name: baseName(f.path),
          key: `${repo.slug}:other:${i}`,
        }));
      if (orphans.length > 0) {
        out.push({
          id: `${repo.slug}:other`,
          title: repo.plugins.length > 0 ? `${repo.slug} (other)` : repo.slug,
          jobs: orphans,
        });
      }
    }
    return out;
  }, [local, repos, repoFiles]);

  // Flat list still needed for job lookup by key in the click handler.
  const flat: FlatJob[] = useMemo(
    () => groups.flatMap((g) => g.jobs),
    [groups],
  );

  const runsForJob = useCallback(
    (job: FlatJob): LogRun[] => {
      const all = home?.logs?.runs ?? [];
      return all.filter((r) => r.file.includes(job.name));
    },
    [home],
  );

  // Expand state encoded as comma-separated keys in URL hash: `?open=key1,key2`.
  // A routine being expanded shows its md + runs children. A runs key
  // (encoded as `<jobKey>#runs`) being expanded shows all its run files.
  const openSet = useMemo(() => {
    const raw = params.get("open") ?? "";
    return new Set(raw ? raw.split(",") : []);
  }, [params]);

  const toggleOpen = useCallback(
    (key: string) => {
      const next = new Set(openSet);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setParam("open", next.size ? Array.from(next).join(",") : null);
    },
    [openSet, setParam],
  );

  if (loading) {
    return <p style={{ padding: 16 }}>Loading routines…</p>;
  }

  // Build per-group, indented row lists. Each row encodes its action via id.
  interface Row {
    id: string;
    name: string;
    detail: string;
    kind: string;
    icon: React.ReactNode;
    meta: RowMeta;
  }
  function buildRowsForGroup(jobs: FlatJob[]): Row[] {
    const out: Row[] = [];
    for (const job of jobs) {
      const routineOpen = openSet.has(job.key);
      out.push({
        id: `routine:${job.key}`,
        name: `${namePrefix(0, routineOpen ? "▽" : "▷")}${job.name}`,
        detail: "",
        kind: "folder",
        icon: <Icon src="folder.png" fallback="📁" />,
        meta: { kind: "routine", jobKey: job.key },
      });
      if (!routineOpen) continue;

      out.push({
        id: `md:${job.key}`,
        name: `${namePrefix(1, null)}${job.name}.md`,
        detail: "",
        kind: "markdown",
        icon: <Icon src="markdown.png" fallback="📄" />,
        meta: { kind: "md", jobKey: job.key },
      });

      const runs = runsForJob(job);
      const runsKey = `${job.key}#runs`;
      const runsOpen = openSet.has(runsKey);
      out.push({
        id: `runs:${job.key}`,
        name: `${namePrefix(1, runsOpen ? "▽" : "▷")}runs`,
        detail: `${runs.length} run${runs.length === 1 ? "" : "s"}`,
        kind: "folder",
        icon: <Icon src="folder.png" fallback="📁" />,
        meta: { kind: "runs", jobKey: job.key },
      });
      if (!runsOpen) continue;

      for (let ri = 0; ri < runs.length; ri++) {
        const run = runs[ri];
        if (!run) continue;
        const filename = run.file.split("/").pop() ?? run.file;
        out.push({
          id: `run:${job.key}:${ri}`,
          name: `${namePrefix(2, null)}${filename}`,
          detail: new Date(run.mtime * 1000).toLocaleString(),
          kind: `${extOf(filename) || "log"} file`,
          icon: <Icon src="log.png" fallback="📄" />,
          meta: { kind: "run", jobKey: job.key, runIdx: ri },
        });
      }
    }
    return out;
  }

  const dialogOpen = editing != null || viewingRun != null;

  // Split the section height across the visible (non-empty) groups so each
  // table gets a reasonable internal scroll area without stealing all space.
  const visibleGroups = groups.filter((g) => g.jobs.length > 0);
  const perGroupHeight =
    visibleGroups.length > 0
      ? Math.max(180, Math.floor(maxHeight / visibleGroups.length) - 24)
      : 280;

  function handleRowClick(rows: Row[], id: string) {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const { meta } = row;
    const job = flat.find((j) => j.key === meta.jobKey);
    if (!job) return;
    if (meta.kind === "routine") toggleOpen(meta.jobKey);
    else if (meta.kind === "runs") toggleOpen(`${meta.jobKey}#runs`);
    else if (meta.kind === "md") setEditing(job);
    else if (meta.kind === "run" && typeof meta.runIdx === "number") {
      const runs = runsForJob(job);
      const run = runs[meta.runIdx];
      if (run) setViewingRun(run);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {visibleGroups.length === 0 ? (
        <p style={{ color: "#555", padding: 16 }}>No routines configured.</p>
      ) : (
        <Tabs fullWidth>
          {visibleGroups.map((group) => {
            const rows = buildRowsForGroup(group.jobs);
            return (
              <TabPanel key={group.id} label={group.title}>
                <ListView
                  columns={[
                    { key: "name", label: "Name", width: "60%" },
                    { key: "detail", label: "Date Modified", width: "25%" },
                    { key: "kind", label: "Kind", width: "15%" },
                  ]}
                  items={rows}
                  selectedIds={[]}
                  onSelectionChange={(ids) => {
                    const id = ids[ids.length - 1];
                    if (id) handleRowClick(rows, id);
                  }}
                />
              </TabPanel>
            );
          })}
        </Tabs>
      )}
      {editing ? (
        <JobEditorDialog
          job={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      ) : null}

      {viewingRun ? (
        <RunViewerDialog run={viewingRun} onClose={() => setViewingRun(null)} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

interface ParsedRun {
  date?: string;
  session?: string;
  model?: string;
  prompt?: string;
  exitCode?: string;
  output?: string;
}

function parseRunLog(lines: string[]): ParsedRun {
  const parsed: ParsedRun = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("Date:")) parsed.date = line.slice(5).trim();
    else if (line.startsWith("Session:")) parsed.session = line.slice(8).trim();
    else if (line.startsWith("Model config:"))
      parsed.model = line.slice(13).trim();
    else if (line.startsWith("Exit code:"))
      parsed.exitCode = line.slice(10).trim();
    else if (line.startsWith("Prompt:")) {
      const parts: string[] = [line.slice(7).trim()];
      i++;
      while (
        i < lines.length &&
        !(lines[i] ?? "").startsWith("Exit code:") &&
        !(lines[i] ?? "").startsWith("## Output")
      ) {
        parts.push(lines[i] ?? "");
        i++;
      }
      parsed.prompt = parts.join("\n").trim();
      continue;
    } else if (line.trim() === "## Output") {
      parsed.output = lines.slice(i + 1).join("\n").trim();
      break;
    }
    i++;
  }
  return parsed;
}

function RunViewerDialog({
  run,
  onClose,
}: {
  run: LogRun;
  onClose: () => void;
}) {
  const filename = run.file.split("/").pop() ?? run.file;
  const parsed = parseRunLog(run.lines);
  const hasChat = parsed.prompt != null || parsed.output != null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={filename}
      width="min(900px, 90vw)"
      height="80vh"
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          height: "100%",
        }}
      >
        {parsed.date || parsed.model || parsed.exitCode ? (
          <div style={{ fontSize: 11, color: "#555", display: "flex", gap: 12 }}>
            {parsed.date ? <span>{parsed.date}</span> : null}
            {parsed.model ? <span>model: {parsed.model}</span> : null}
            {parsed.exitCode ? <span>exit: {parsed.exitCode}</span> : null}
          </div>
        ) : null}
        <Os9Scroll style={{ flex: 1, minHeight: 0 }}>
          <div
            style={{
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {hasChat ? (
              <>
                {parsed.prompt ? (
                  <MessageBubble role="user" text={parsed.prompt} />
                ) : null}
                {parsed.output ? (
                  <MessageBubble role="assistant" text={parsed.output} />
                ) : null}
              </>
            ) : (
              <pre
                style={{
                  margin: 0,
                  fontFamily: "monospace",
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                }}
              >
                {run.lines.join("\n")}
              </pre>
            )}
          </div>
        </Os9Scroll>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

function JobEditorDialog({
  job,
  onClose,
  onSaved,
}: {
  job: FlatJob;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fm, setFm] = useState<ParsedFm | null>(null);
  const [body, setBody] = useState("");
  const [name, setName] = useState(job.name);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getJobFile(job.path, job.repoSlug);
        if (cancelled) return;
        const parsed = parseFm(res.content);
        setFm(parsed.fm);
        setBody(parsed.body);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job.path, job.repoSlug]);

  const handleSave = useCallback(async () => {
    if (!fm) return;
    setSaving(true);
    try {
      const content = serializeFm(fm, body);
      const cleanName = name.trim().replace(/\.md$/i, "");
      if (cleanName !== job.name) {
        const newPath = `${dirOf(job.path)}${cleanName}.md`;
        await createJobFile(newPath, job.repoSlug);
        await writeJobFile(newPath, content, job.repoSlug);
        await deleteJobFile(job.path, job.repoSlug);
      } else {
        await writeJobFile(job.path, content, job.repoSlug);
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }, [fm, body, name, job, onSaved]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit routine: ${job.name}`}
      width="min(720px, 90vw)"
      height="80vh"
    >
      {loading || !fm ? (
        <p>Loading…</p>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            height: "100%",
          }}
        >
          <label>
            <div style={{ fontSize: 11, marginBottom: 2 }}>Name</div>
            <TextField
              value={name}
              onChange={(e) => setName(e.target.value)}
              fullWidth
            />
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Checkbox
              checked={fm.enabled}
              onChange={(e) => setFm({ ...fm, enabled: e.target.checked })}
              label="Enabled"
            />
            <Checkbox
              checked={fm.recurring}
              onChange={(e) => setFm({ ...fm, recurring: e.target.checked })}
              label="Recurring"
            />
            <Checkbox
              checked={fm.notify}
              onChange={(e) => setFm({ ...fm, notify: e.target.checked })}
              label="Notify"
            />
          </div>
          <label>
            <div style={{ fontSize: 11, marginBottom: 2 }}>Schedule (cron)</div>
            <TextField
              value={fm.schedule}
              onChange={(e) => setFm({ ...fm, schedule: e.target.value })}
              placeholder="*/15 * * * *"
              fullWidth
            />
          </label>
          <label>
            <div style={{ fontSize: 11, marginBottom: 2 }}>Prompt</div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              style={{
                width: "100%",
                fontFamily: "monospace",
                fontSize: 12,
                resize: "vertical",
              }}
            />
          </label>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              loading={saving}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
