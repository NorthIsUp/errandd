import { ArrowUpRight, CalendarClock, PlugZap, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getApiToken } from "../../api/client";
import { listRepos, type RepoStatus } from "../../api/repos";
import { listSessions, type SessionInfo } from "../../api/sessions";
import { getState, type StateResponse } from "../../api/state";
import { Card } from "../components/Card";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { formatRoute } from "../router";
import { useAsync } from "../useAsync";

/**
 * Roll-up of every clawdcode "run". One row per claude session.
 *
 * "Run" is intentionally session-shaped, not delivery-shaped: a
 * hook-driven job that gets re-triggered (a new comment on the same
 * PR) resumes the same session — those re-triggers are appended turns
 * on the existing row rather than spawning new rows. That matches
 * the user-visible model: one row per PR-worktree conversation.
 *
 * Cron / manual chats are one-row-per-session too, since they don't
 * have a scope to coalesce on.
 *
 * Columns:
 *   Routine   — name of the .md file (link to its detail page)
 *   Trigger   — hook scope (pr-1488-…), cron expression, or "manual"
 *   Status    — running / ok / error / skipped / idle (from live SSE
 *               status when the daemon is running it, else
 *               JobSummary.lastResult)
 *   Turns     — session.turnCount
 *   Tokens    — (TBD — needs /api/sessions/<id>/usage; "—" for now)
 *   Duration  — lastUsedAt − createdAt
 */
export function RunsSection() {
  const state = useAsync<StateResponse>(() => getState());
  const sessions = useAsync<SessionInfo[]>(() => listSessions(true));
  const repos = useAsync<RepoStatus[]>(() => listRepos());

  // Subscribe to live job status (same SSE channel the Schedule table uses).
  const [activeJobs, setActiveJobs] = useState<Set<string>>(new Set());
  useEffect(() => {
    const token = getApiToken();
    const url = `/api/jobs/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev?.type === "status" && Array.isArray(ev.active)) {
          setActiveJobs(new Set<string>(ev.active));
        }
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, []);

  // Name → (slug, path) so a routine link goes to /routines/<slug>/<file>.
  const fileMap = useMemo(() => buildFileMap(repos.data ?? []), [repos.data]);

  const rows = useMemo(
    () => buildRows(sessions.data ?? [], state.data?.jobs ?? [], fileMap, activeJobs),
    [sessions.data, state.data?.jobs, fileMap, activeJobs],
  );

  const loading = state.loading || sessions.loading || repos.loading;
  const errors = [state.error, sessions.error, repos.error].filter(Boolean);

  return (
    <>
      <PageHeader title="Runs" crumbs={[{ label: "Runs" }]} />
      <Card
        title={
          <span className="text-sm">
            <span className="font-semibold">{rows.length}</span> run
            {rows.length === 1 ? "" : "s"}
          </span>
        }
      >
        {loading && <Loader />}
        {errors.map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable per-position list of API errors, no other key available
          <ErrorBanner key={i} error={e} />
        ))}
        {!loading && rows.length === 0 && <Empty>No runs yet.</Empty>}

        {rows.length > 0 && (
          <>
            {/* Mobile stack */}
            <ul className="md:hidden divide-y divide-base-300 -mx-2">
              {rows.map((r) => (
                <li key={r.session.id} className="px-2 py-2 min-w-0">
                  <div className="flex items-baseline justify-between gap-2 min-w-0">
                    <RoutineLink row={r} />
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="text-xs text-base-content/70 truncate mt-0.5">
                    <TriggerCell row={r} />
                  </div>
                  <div className="text-[11px] text-base-content/60 mt-0.5 flex flex-wrap gap-3 tabular-nums">
                    <span>{r.session.turnCount} turns</span>
                    <span>{formatDuration(r.durationMs)}</span>
                    <time dateTime={r.session.lastUsedAt}>
                      {new Date(r.session.lastUsedAt).toLocaleString()}
                    </time>
                  </div>
                </li>
              ))}
            </ul>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto -mx-2">
              <table className="table table-sm">
                <thead>
                  <tr className="text-xs uppercase text-base-content/60">
                    <th>Routine</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th className="text-right">Turns</th>
                    <th className="text-right">Tokens</th>
                    <th className="text-right">Duration</th>
                    <th aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.session.id}>
                      <td className="font-mono text-sm">
                        <RoutineLink row={r} />
                      </td>
                      <td className="text-xs">
                        <TriggerCell row={r} />
                      </td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="text-right tabular-nums">{r.session.turnCount}</td>
                      <td className="text-right tabular-nums text-base-content/50">—</td>
                      <td className="text-right tabular-nums text-xs">
                        {formatDuration(r.durationMs)}
                      </td>
                      <td className="text-right">
                        <a
                          className="btn btn-xs btn-ghost"
                          href={`${location.pathname}${formatRoute("chat", [r.session.id])}`}
                          aria-label={`Open chat ${r.session.id}`}
                        >
                          <ArrowUpRight size={14} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

interface RunRow {
  session: SessionInfo;
  routineName: string;
  routinePath: { slug: string; path: string } | null;
  trigger: TriggerInfo;
  status: "running" | "ok" | "error" | "skipped" | "idle";
  durationMs: number;
}

type TriggerInfo =
  | { kind: "hook"; scope: string; event: string }
  | { kind: "schedule"; cron: string }
  | { kind: "manual" };

function buildRows(
  sessions: SessionInfo[],
  jobs: import("../../api/state").JobSummary[],
  fileMap: Map<string, { slug: string; path: string }>,
  activeJobs: Set<string>,
): RunRow[] {
  const jobByName = new Map(jobs.map((j) => [j.name, j]));

  const out: RunRow[] = sessions.map((s) => {
    const routineName = s.jobName ?? s.title ?? "(none)";
    const trigger = detectTrigger(s, jobByName.get(routineName) ?? null);
    const status = detectStatus(s, jobByName.get(routineName) ?? null, activeJobs);
    const durationMs = Math.max(
      0,
      new Date(s.lastUsedAt).getTime() - new Date(s.createdAt).getTime(),
    );
    return {
      session: s,
      routineName,
      routinePath: fileMap.get(routineName) ?? null,
      trigger,
      status,
      durationMs,
    };
  });

  // Newest first.
  out.sort((a, b) => b.session.lastUsedAt.localeCompare(a.session.lastUsedAt));
  return out;
}

function detectTrigger(
  s: SessionInfo,
  job: import("../../api/state").JobSummary | null,
): TriggerInfo {
  const m = s.firstMessage.match(/Triggered by GitHub (\S+).*? for scope `([^`]+)`/);
  if (m) {
    return { kind: "hook", event: m[1] ?? "?", scope: m[2] ?? "?" };
  }
  if (job?.schedule) {
    return { kind: "schedule", cron: job.schedule };
  }
  return { kind: "manual" };
}

function detectStatus(
  s: SessionInfo,
  job: import("../../api/state").JobSummary | null,
  activeJobs: Set<string>,
): RunRow["status"] {
  if (activeJobs.has(s.jobName ?? "") || (job?.running ?? false)) {
    return "running";
  }
  // Per-job last result is the closest proxy we have for "did the most
  // recent run of *this routine* succeed". It's not strictly per-session
  // (a session can have many turns) but for hook-driven jobs each run is
  // one delivery → one result, so this lines up most of the time.
  switch (job?.lastResult) {
    case "ok":
      return "ok";
    case "error":
      return "error";
    case "skipped":
      return "skipped";
    default:
      return "idle";
  }
}

function buildFileMap(
  repos: RepoStatus[],
): Map<string, { slug: string; path: string }> {
  const m = new Map<string, { slug: string; path: string }>();
  // Each repo can host multiple plugins; the routine "name" is the .md
  // filename without extension, but we don't have a routine listing here
  // — only the plugin entry points. The fileMap is filled lazily by
  // the JobsSection routine browser; for now we just register each
  // plugin's `name` as a slug fallback so the link doesn't 404.
  for (const r of repos) {
    if (!r.cloned) continue;
    for (const p of r.plugins) {
      m.set(p.name, { slug: r.slug, path: `${p.name}.md` });
    }
  }
  return m;
}

// ---------------------------------------------------------------------------

function RoutineLink({ row }: { row: RunRow }) {
  if (row.routinePath) {
    const { slug, path } = row.routinePath;
    return (
      <a
        href={`${location.pathname}${formatRoute("routines", [slug, path])}`}
        className="link link-hover font-medium"
      >
        {row.routineName}
      </a>
    );
  }
  return <span className="font-medium">{row.routineName}</span>;
}

function TriggerCell({ row }: { row: RunRow }) {
  const t = row.trigger;
  if (t.kind === "hook") {
    return (
      <span className="inline-flex items-center gap-1 text-base-content/80 min-w-0">
        <PlugZap size={12} className="opacity-70 shrink-0" aria-hidden />
        <span className="font-mono truncate" title={`${t.event} · ${t.scope}`}>
          {t.scope}
        </span>
      </span>
    );
  }
  if (t.kind === "schedule") {
    return (
      <span className="inline-flex items-center gap-1 text-base-content/80 min-w-0">
        <CalendarClock size={12} className="opacity-70 shrink-0" aria-hidden />
        <span className="font-mono truncate" title={t.cron}>
          {t.cron}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-base-content/60">
      <User size={12} aria-hidden /> manual
    </span>
  );
}

function StatusBadge({ status }: { status: RunRow["status"] }) {
  switch (status) {
    case "running":
      return <span className="badge badge-info badge-sm">running</span>;
    case "ok":
      return <span className="badge badge-success badge-sm">ok</span>;
    case "error":
      return <span className="badge badge-error badge-sm">error</span>;
    case "skipped":
      return <span className="badge badge-warning badge-sm">skipped</span>;
    default:
      return <span className="badge badge-ghost badge-sm">idle</span>;
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
