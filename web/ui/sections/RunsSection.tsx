import { Bug, CalendarClock, LineChart, PlugZap, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getApiToken } from "../../api/client";
import { listRepos, type RepoStatus } from "../../api/repos";
import { listSessions, type SessionInfo } from "../../api/sessions";
import { getState, type StateResponse } from "../../api/state";
import { Card } from "../components/Card";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { formatRoute, useRoute } from "../router";
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
  const { goto } = useRoute();
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
          setActiveJobs((prev) => {
            const next = new Set<string>(ev.active);
            // When a job leaves the active set, its session just
            // finished — refetch sessions so the per-session `result`
            // shows up. Otherwise the row stays painted "running"
            // until the user reloads the page manually.
            let leftActive = false;
            for (const name of prev) {
              if (!next.has(name)) {
                leftActive = true;
                break;
              }
            }
            if (leftActive) {
              sessions.reload();
            }
            return next;
          });
        }
      } catch {
        // ignore
      }
    };
    return () => es.close();
    // EventSource lifetime is component-scoped — `sessions.reload` is a
    // stable callback from useAsync, so capturing it once is fine.
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
                <li
                  key={r.session.id}
                  className="px-2 py-2 min-w-0 cursor-pointer hover:bg-base-200"
                  onClick={() => goto("chat", [r.session.id])}
                >
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
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.session.id}
                      className="cursor-pointer hover:bg-base-200"
                      onClick={() => goto("chat", [r.session.id])}
                    >
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
  | {
      kind: "hook";
      event: string;
      /** Pre-humanized phrase, e.g. "comment on PR #415". */
      label: string;
      pr?: { number: number; url?: string } | null;
      repo?: string | null;
    }
  | { kind: "schedule"; cron: string }
  | { kind: "manual" };

function buildRows(
  sessions: SessionInfo[],
  jobs: import("../../api/state").JobSummary[],
  fileMap: Map<string, { slug: string; path: string }>,
  activeJobs: Set<string>,
): RunRow[] {
  const jobByName = new Map(jobs.map((j) => [j.name, j]));

  // The SSE channel reports active job NAMES, not session IDs. Naively
  // marking every session of an active job as "running" lights up every
  // historical row for that job. Only the most-recently-kicked-off
  // session per routine is plausibly the one currently executing — so
  // pre-compute that and gate the "running" badge on it.
  const latestByRoutine = new Map<string, string>(); // routineName → session.id
  for (const s of sessions) {
    const name = s.jobName ?? s.title ?? "(none)";
    const prev = latestByRoutine.get(name);
    if (!prev || s.createdAt > (sessions.find((x) => x.id === prev)?.createdAt ?? "")) {
      latestByRoutine.set(name, s.id);
    }
  }

  const out: RunRow[] = sessions.map((s) => {
    const routineName = s.jobName ?? s.title ?? "(none)";
    const trigger = detectTrigger(s, jobByName.get(routineName) ?? null);
    const isLatest = latestByRoutine.get(routineName) === s.id;
    const status = detectStatus(s, jobByName.get(routineName) ?? null, activeJobs, isLatest);
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

  // Newest kickoff first — sort by createdAt rather than lastUsedAt so a
  // long-running session that's still ticking turns doesn't jump above
  // a more-recently-started one.
  out.sort((a, b) => b.session.createdAt.localeCompare(a.session.createdAt));
  return out;
}

function detectTrigger(
  s: SessionInfo,
  job: import("../../api/state").JobSummary | null,
): TriggerInfo {
  // Prefer the trigger persisted on the session-meta side. A given job
  // can have BOTH a schedule and hook config, so only the per-session
  // record is authoritative.
  if (s.trigger?.kind === "hook") {
    return {
      kind: "hook",
      event: s.trigger.event,
      label: humanizeHookTrigger(s.trigger),
      pr: s.trigger.pr ?? null,
      repo: s.trigger.repo ?? null,
    };
  }
  if (s.trigger?.kind === "schedule") {
    return { kind: "schedule", cron: s.trigger.cron };
  }
  if (s.trigger?.kind === "manual") {
    return { kind: "manual" };
  }
  // Legacy sessions predating the trigger field — fall back to the
  // first-message regex and the job's schedule.
  const m = s.firstMessage.match(/Triggered by GitHub (\S+).*? for scope `([^`]+)`/);
  if (m) {
    return { kind: "hook", event: m[1] ?? "?", label: m[1] ?? "?" };
  }
  if (job?.schedule) {
    return { kind: "schedule", cron: job.schedule };
  }
  return { kind: "manual" };
}

/** Turn a structured hook trigger into a human-readable phrase like
 *  "comment on PR #415", "review of PR #415", "Sentry resolved — my-app",
 *  or "Datadog error — monitor 1234". */
function humanizeHookTrigger(t: {
  event: string;
  action?: string;
  repo?: string | null;
  pr?: { number: number };
}): string {
  const pr = t.pr ? `PR #${t.pr.number}` : null;
  const event = t.event;
  const action = t.action ?? "";

  // Non-GitHub providers reuse `repo` as the "where" (Sentry project slug
  // or Datadog `monitor <id>`) and `action` as the event kind.
  if (event.startsWith("sentry:")) {
    const where = t.repo ?? "";
    if (action && where) return `Sentry ${action} — ${where}`;
    if (where) return `Sentry — ${where}`;
    if (action) return `Sentry ${action}`;
    return "Sentry event";
  }
  if (event.startsWith("datadog:")) {
    const where = t.repo ?? "";
    if (action && where) return `Datadog ${action} — ${where}`;
    if (where) return `Datadog — ${where}`;
    if (action) return `Datadog ${action}`;
    return "Datadog alert";
  }

  if (event === "issue_comment" && pr) return `comment on ${pr}`;
  if (event === "pull_request_review_comment" && pr) return `comment on ${pr}`;
  if (event === "pull_request_review" && pr) {
    if (action === "submitted" || action === "edited") return `review of ${pr}`;
    return `review on ${pr}`;
  }
  if (event === "pull_request" && pr) {
    if (action === "opened") return `${pr} opened`;
    if (action === "synchronize") return `${pr} updated`;
    if (action === "closed") return `${pr} closed`;
    if (action === "reopened") return `${pr} reopened`;
    if (action === "ready_for_review") return `${pr} ready for review`;
    if (action === "converted_to_draft") return `${pr} → draft`;
    if (action) return `${pr} ${action}`;
    return pr;
  }
  return pr ? `${event} on ${pr}` : event;
}

function detectStatus(
  s: SessionInfo,
  job: import("../../api/state").JobSummary | null,
  activeJobs: Set<string>,
  isLatestSession: boolean,
): RunRow["status"] {
  // "Running" only applies to the most recent session of an active job.
  if (isLatestSession && (activeJobs.has(s.jobName ?? "") || (job?.running ?? false))) {
    return "running";
  }
  // Per-session result is authoritative — gives historical rows their
  // own status instead of all flipping when the current run completes.
  if (s.result) {
    return s.result;
  }
  // Legacy fallback for sessions predating per-session result. Only
  // applies to the latest row so old history doesn't all light up.
  if (!isLatestSession) {
    return "idle";
  }
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
        // Don't let the click bubble up to the row's onClick — clicking
        // the name goes to the .md file; clicking the rest of the row
        // goes to the chat detail.
        onClick={(e) => e.stopPropagation()}
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
    const Icon = t.event.startsWith("sentry:")
      ? Bug
      : t.event.startsWith("datadog:")
        ? LineChart
        : PlugZap;
    return (
      <span className="inline-flex items-center gap-1 text-base-content/80 min-w-0">
        <Icon size={12} className="opacity-70 shrink-0" aria-hidden />
        <span className="truncate" title={t.event}>
          {t.label}
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
