import {
  ArrowDown,
  ArrowUp,
  Bug,
  CalendarClock,
  ChevronsUpDown,
  Clipboard,
  LineChart,
  PlugZap,
  RefreshCw,
  User,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getApiToken } from "../../api/client";
import { listRepos, type RepoStatus } from "../../api/repos";
import { getHookPayload, listSessions, reprocessHook, type SessionInfo } from "../../api/sessions";
import { getState, type StateResponse } from "../../api/state";
import { Card } from "../components/Card";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { formatRoute, useRoute } from "../router";
import { useAsync } from "../useAsync";

/**
 * Roll-up of every errandd "run". One row per claude session.
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
  const [activeJobs, setActiveJobs] = useState<Set<string>>(() => new Set());
  // `reload` from useAsync is a stable useCallback, so depending on it keeps the
  // EventSource mounted once while satisfying exhaustive-deps.
  const reloadSessions = sessions.reload;
  useEffect(() => {
    const token = getApiToken();
    const url = `/api/jobs/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(String(e.data)) as { type?: string; active?: string[] };
        if (ev.type === "status" && Array.isArray(ev.active)) {
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
              reloadSessions();
            }
            return next;
          });
        }
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [reloadSessions]);

  // Name → (slug, path) so a routine link goes to /routines/<slug>/<file>.
  const fileMap = useMemo(() => buildFileMap(repos.data ?? []), [repos.data]);

  const rows = useMemo(
    () => buildRows(sessions.data ?? [], state.data?.jobs ?? [], fileMap, activeJobs),
    [sessions.data, state.data?.jobs, fileMap, activeJobs],
  );

  // Distinct values present in the current rows, for the data-driven
  // dropdowns (routine name, repo, PR, status, provider, trigger kind).
  const facets = useMemo(() => buildFacets(rows), [rows]);

  // One bit of filter state per dimension; "all" means unfiltered. The
  // data-driven dropdowns fall back to "all" during render if their
  // selected value vanishes on a reload (rather than resetting in an
  // effect). PR is held as a string and compared numerically.
  const [routineFilter, setRoutineFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [triggerFilter, setTriggerFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [repoFilter, setRepoFilter] = useState("all");
  const [prFilter, setPrFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState("all");

  const eRoutine = pick(routineFilter, facets.routines);
  const eStatus = pick(statusFilter, facets.statuses);
  const eTrigger = pick(triggerFilter, facets.triggers);
  const eProvider = pick(providerFilter, facets.providers);
  const eRepo = pick(repoFilter, facets.repos);
  const ePr = pick(prFilter, facets.prs);
  const f: FilterValues = {
    routine: eRoutine,
    status: eStatus,
    trigger: eTrigger,
    provider: eProvider,
    repo: eRepo,
    pr: ePr,
    time: timeFilter,
  };

  const filteredRows = useMemo(
    () =>
      applyFilters(rows, {
        routine: eRoutine,
        status: eStatus,
        trigger: eTrigger,
        provider: eProvider,
        repo: eRepo,
        pr: ePr,
        time: timeFilter,
      }),
    [rows, eRoutine, eStatus, eTrigger, eProvider, eRepo, ePr, timeFilter],
  );

  // Sort. Defaults to newest-first by Time; clicking a column header
  // toggles direction (or switches column at its natural default dir).
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const onSort = (col: SortKey) => {
    if (col === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col);
      setSortDir(DEFAULT_DIR[col]);
    }
  };

  const sortedRows = useMemo(() => {
    const cmp = SORTERS[sortKey];
    const sign = sortDir === "asc" ? 1 : -1;
    // Stable: JS sort preserves input order on ties, and filteredRows
    // already arrives newest-kickoff-first from buildRows.
    return [...filteredRows].sort((a, b) => sign * cmp(a, b));
  }, [filteredRows, sortKey, sortDir]);

  const loading = state.loading || sessions.loading || repos.loading;
  const errors = [state.error, sessions.error, repos.error].filter(Boolean);

  return (
    <>
      <PageHeader title="Runs" crumbs={[{ label: "Runs" }]} />
      <Card
        title={
          <span className="text-sm">
            <span className="font-semibold">{filteredRows.length}</span>
            {filteredRows.length !== rows.length && (
              <span className="text-base-content/50"> of {rows.length}</span>
            )}{" "}
            run{rows.length === 1 ? "" : "s"}
          </span>
        }
      >
        {loading && <Loader />}
        {errors.map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable per-position list of API errors, no other key available
          <ErrorBanner key={i} error={e} />
        ))}
        {!loading && rows.length > 0 && (
          <FilterBar
            facets={facets}
            values={{
              routine: routineFilter,
              status: statusFilter,
              trigger: triggerFilter,
              provider: providerFilter,
              repo: repoFilter,
              pr: prFilter,
              time: timeFilter,
            }}
            effective={f}
            set={{
              routine: setRoutineFilter,
              status: setStatusFilter,
              trigger: setTriggerFilter,
              provider: setProviderFilter,
              repo: setRepoFilter,
              pr: setPrFilter,
              time: setTimeFilter,
            }}
            onReset={() => {
              setRoutineFilter("all");
              setStatusFilter("all");
              setTriggerFilter("all");
              setProviderFilter("all");
              setRepoFilter("all");
              setPrFilter("all");
              setTimeFilter("all");
            }}
          />
        )}
        {!loading && rows.length === 0 && <Empty>No runs yet.</Empty>}
        {!loading && rows.length > 0 && filteredRows.length === 0 && (
          <Empty>No runs match these filters.</Empty>
        )}

        {filteredRows.length > 0 && (
          <>
            {/* Mobile sort control (the desktop table sorts via headers). */}
            <div className="md:hidden flex items-center gap-2 mb-2">
              <select
                className="select select-sm select-bordered"
                value={sortKey}
                onChange={(e) => onSort(e.target.value as SortKey)}
                aria-label="Sort by"
              >
                {SORT_COLUMNS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-square"
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                aria-label={sortDir === "asc" ? "Ascending" : "Descending"}
                title={sortDir === "asc" ? "Ascending" : "Descending"}
              >
                {sortDir === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
              </button>
            </div>

            {/* Mobile stack */}
            <ul className="md:hidden divide-y divide-base-300 -mx-2">
              {sortedRows.map((r) => (
                // Mouse-convenience row nav (mobile stack). `<li>` can't take an
                // interactive role, and the row already contains the keyboard-
                // reachable RoutineLink, so the whole-row click stays mouse-only.
                // See TODO.md for the proper keyboard affordance.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
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
                    {SORT_COLUMNS.map((c) => (
                      <SortHeader
                        key={c.key}
                        column={c.key}
                        label={c.label}
                        align={c.align}
                        activeKey={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                      />
                    ))}
                    <th className="text-right">Hook</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => (
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
                      <td className="text-right tabular-nums text-xs text-base-content/70 whitespace-nowrap">
                        <time dateTime={r.session.lastUsedAt} title={new Date(r.session.lastUsedAt).toLocaleString()}>
                          {formatRelativeTime(r.session.lastUsedAt)}
                        </time>
                      </td>
                      <td className="text-right whitespace-nowrap">
                        {r.trigger.kind === "hook" && <HookActions sessionId={r.session.id} />}
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
  status: "running" | "ok" | "error" | "skipped" | "pass" | "idle";
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

// --- Sorting ---------------------------------------------------------------

type SortKey = "routine" | "trigger" | "status" | "turns" | "tokens" | "duration" | "time";
type SortDir = "asc" | "desc";

// Column definitions drive both the desktop headers and the mobile sort
// dropdown, so the two stay in lockstep.
const SORT_COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "routine", label: "Routine" },
  { key: "trigger", label: "Trigger" },
  { key: "status", label: "Status" },
  { key: "turns", label: "Turns", align: "right" },
  { key: "tokens", label: "Tokens", align: "right" },
  { key: "duration", label: "Duration", align: "right" },
  { key: "time", label: "Time", align: "right" },
];

// Natural default direction when first clicking a column: text ascending,
// numbers/time descending (biggest/newest first).
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  routine: "asc",
  trigger: "asc",
  status: "asc",
  turns: "desc",
  tokens: "desc",
  duration: "desc",
  time: "desc",
};

/** The text a trigger sorts by — matches what TriggerCell renders. */
function triggerText(t: TriggerInfo): string {
  if (t.kind === "hook") return t.label;
  if (t.kind === "schedule") return t.cron;
  return "manual";
}

const SORTERS: Record<SortKey, (a: RunRow, b: RunRow) => number> = {
  routine: (a, b) =>
    a.routineName.localeCompare(b.routineName, undefined, { sensitivity: "base" }),
  trigger: (a, b) => triggerText(a.trigger).localeCompare(triggerText(b.trigger)),
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  turns: (a, b) => a.session.turnCount - b.session.turnCount,
  // Tokens has no data yet (always "—"); sort is a stable no-op for now.
  tokens: () => 0,
  duration: (a, b) => a.durationMs - b.durationMs,
  time: (a, b) =>
    new Date(a.session.lastUsedAt).getTime() - new Date(b.session.lastUsedAt).getTime(),
};

// --- Filtering -------------------------------------------------------------

type FilterKey = "routine" | "status" | "trigger" | "provider" | "repo" | "pr" | "time";
type FilterValues = Record<FilterKey, string>;

interface Facets {
  routines: string[];
  statuses: string[];
  triggers: string[]; // "hook" | "schedule" | "manual"
  providers: string[]; // "github" | "sentry" | "datadog"
  repos: string[];
  prs: string[]; // PR numbers as strings, newest first
}

/** Provider behind a hook trigger, or null for schedule/manual. */
function providerOf(t: TriggerInfo): string | null {
  if (t.kind !== "hook") return null;
  if (t.event.startsWith("sentry:")) return "sentry";
  if (t.event.startsWith("datadog:")) return "datadog";
  return "github";
}

// Status / trigger / provider have a fixed display order; only the values
// actually present in the data get a dropdown entry.
const STATUS_ORDER = ["running", "ok", "pass", "error", "skipped", "idle"];
const TRIGGER_ORDER = ["hook", "schedule", "manual"];
const PROVIDER_ORDER = ["github", "sentry", "datadog"];

const TIME_WINDOWS_MS: Record<string, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

function buildFacets(rows: RunRow[]): Facets {
  const routines = new Set<string>();
  const statuses = new Set<string>();
  const triggers = new Set<string>();
  const providers = new Set<string>();
  const repos = new Set<string>();
  const prs = new Set<number>();
  for (const r of rows) {
    routines.add(r.routineName);
    statuses.add(r.status);
    triggers.add(r.trigger.kind);
    const provider = providerOf(r.trigger);
    if (provider) providers.add(provider);
    if (r.trigger.kind === "hook") {
      if (r.trigger.repo) repos.add(r.trigger.repo);
      if (r.trigger.pr) prs.add(r.trigger.pr.number);
    }
  }
  const inData = (set: Set<string>) => (v: string) => set.has(v);
  return {
    routines: [...routines].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    ),
    statuses: STATUS_ORDER.filter(inData(statuses)),
    triggers: TRIGGER_ORDER.filter(inData(triggers)),
    providers: PROVIDER_ORDER.filter(inData(providers)),
    repos: [...repos].sort((a, b) => a.localeCompare(b)),
    prs: [...prs].sort((a, b) => b - a).map(String),
  };
}

/** Keep a selected filter value only if it's still present in the data
 *  (or the open-ended "time"); otherwise collapse to "all". */
function pick(value: string, options: string[]): string {
  return value !== "all" && !options.includes(value) ? "all" : value;
}

function applyFilters(rows: RunRow[], f: FilterValues): RunRow[] {
  const cutoff = f.time === "all" ? 0 : Date.now() - (TIME_WINDOWS_MS[f.time] ?? 0);
  return rows.filter((r) => {
    if (f.routine !== "all" && r.routineName !== f.routine) return false;
    if (f.status !== "all" && r.status !== f.status) return false;
    if (f.trigger !== "all" && r.trigger.kind !== f.trigger) return false;
    if (f.provider !== "all" && providerOf(r.trigger) !== f.provider) return false;
    if (f.repo !== "all" && (r.trigger.kind !== "hook" || r.trigger.repo !== f.repo)) {
      return false;
    }
    if (f.pr !== "all") {
      const pr = r.trigger.kind === "hook" ? r.trigger.pr?.number : undefined;
      if (pr === undefined || String(pr) !== f.pr) return false;
    }
    if (cutoff && new Date(r.session.lastUsedAt).getTime() < cutoff) return false;
    return true;
  });
}

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
  const m = /Triggered by GitHub (\S+).*? for scope `([^`]+)`/.exec(s.firstMessage);
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
    case "pass":
      return "pass";
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

// Human labels for the fixed-vocabulary facets. Routine/repo/PR are shown
// verbatim, so they're not listed here.
const TRIGGER_LABELS: Record<string, string> = {
  hook: "Hook",
  schedule: "Schedule",
  manual: "Manual",
};
const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  sentry: "Sentry",
  datadog: "Datadog",
};
const TIME_OPTIONS = [
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

function FilterBar({
  facets,
  values,
  effective,
  set,
  onReset,
}: {
  facets: Facets;
  values: FilterValues;
  effective: FilterValues;
  set: Record<FilterKey, (v: string) => void>;
  onReset: () => void;
}) {
  const anyActive = Object.values(effective).some((v) => v !== "all");
  const opt = (v: string, label?: string) => ({ value: v, label: label ?? v });

  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      {facets.routines.length > 1 && (
        <FilterSelect
          allLabel="All routines"
          value={effective.routine}
          onChange={set.routine}
          options={facets.routines.map((n) => opt(n))}
        />
      )}
      {facets.statuses.length > 1 && (
        <FilterSelect
          allLabel="Any status"
          value={effective.status}
          onChange={set.status}
          options={facets.statuses.map((s) => opt(s))}
        />
      )}
      {facets.triggers.length > 1 && (
        <FilterSelect
          allLabel="Any trigger"
          value={effective.trigger}
          onChange={set.trigger}
          options={facets.triggers.map((t) => opt(t, TRIGGER_LABELS[t]))}
        />
      )}
      {facets.providers.length > 1 && (
        <FilterSelect
          allLabel="Any provider"
          value={effective.provider}
          onChange={set.provider}
          options={facets.providers.map((p) => opt(p, PROVIDER_LABELS[p]))}
        />
      )}
      {facets.repos.length > 1 && (
        <FilterSelect
          allLabel="All repos"
          value={effective.repo}
          onChange={set.repo}
          options={facets.repos.map((r) => opt(r))}
        />
      )}
      {facets.prs.length > 0 && (
        <FilterSelect
          allLabel="Any PR"
          value={effective.pr}
          onChange={set.pr}
          options={facets.prs.map((n) => opt(n, `PR #${n}`))}
        />
      )}
      <FilterSelect
        allLabel="Any time"
        value={values.time}
        onChange={set.time}
        options={TIME_OPTIONS}
      />
      {anyActive && (
        <button type="button" className="btn btn-ghost btn-xs" onClick={onReset}>
          Clear
        </button>
      )}
    </div>
  );
}

function FilterSelect({
  allLabel,
  value,
  onChange,
  options,
}: {
  allLabel: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      className="select select-sm select-bordered max-w-[12rem]"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={allLabel}
    >
      <option value="all">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SortHeader({
  column,
  label,
  align,
  activeKey,
  dir,
  onSort,
}: {
  column: SortKey;
  label: string;
  align?: "right" | undefined;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (col: SortKey) => void;
}) {
  const active = activeKey === column;
  return (
    <th className={align === "right" ? "text-right" : undefined} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`inline-flex items-center gap-1 uppercase select-none hover:text-base-content ${
          active ? "text-base-content" : ""
        }`}
        onClick={() => onSort(column)}
      >
        <span>{label}</span>
        {active ? (
          dir === "asc" ? (
            <ArrowUp size={12} aria-hidden />
          ) : (
            <ArrowDown size={12} aria-hidden />
          )
        ) : (
          <ChevronsUpDown size={12} className="opacity-30" aria-hidden />
        )}
      </button>
    </th>
  );
}

/** Per-row hook actions: copy the full delivery JSON, or reprocess (replay)
 *  the stored delivery through the matcher. Clicks don't bubble to the row's
 *  navigate-to-chat handler. */
function HookActions({ sessionId }: { sessionId: string }) {
  const [flash, setFlash] = useState<"copied" | "reprocessed" | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  const ping = (s: "copied" | "reprocessed" | "error") => {
    setFlash(s);
    setTimeout(() => setFlash(null), 1500);
  };

  async function copyJson(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    try {
      const p = await getHookPayload(sessionId);
      await navigator.clipboard.writeText(JSON.stringify(p.payload, null, 2));
      ping("copied");
    } catch {
      ping("error");
    }
  }
  async function reprocess(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    setBusy(true);
    try {
      await reprocessHook(sessionId);
      ping("reprocessed");
    } catch {
      ping("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper around buttons; the buttons carry the real actions
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- wrapper only stops row-click bubbling; the inner buttons are the real keyboard-accessible controls
    <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={(e) => void copyJson(e)}
        title="Copy full hook JSON"
        aria-label="Copy full hook JSON"
      >
        {flash === "copied" ? "✓" : <Clipboard size={13} />}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={(e) => void reprocess(e)}
        disabled={busy}
        title="Reprocess hook (replay this delivery)"
        aria-label="Reprocess hook"
      >
        {flash === "reprocessed" ? "✓" : <RefreshCw size={13} className={busy ? "animate-spin" : ""} />}
      </button>
    </span>
  );
}

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
    case "pass":
      // Agent ran and chose to no-op (e.g. nothing actionable) — distinct
      // from a system "skipped" (matcher decided not to spawn).
      return <span className="badge badge-neutral badge-sm">pass</span>;
    case "error":
      return <span className="badge badge-error badge-sm">error</span>;
    case "skipped":
      return <span className="badge badge-warning badge-sm">skipped</span>;
    default:
      return <span className="badge badge-ghost badge-sm">idle</span>;
  }
}

/** Compact relative time for the Runs table ("3m", "2h", "5d"), falling
 *  back to a locale date once it's older than a week. The full timestamp
 *  is always available on the cell's `title`. */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(then).toLocaleDateString();
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
