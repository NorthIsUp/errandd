import { AlertTriangle, ArrowDown, ArrowUp, CircleOff, Pause } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getApiToken } from "../../api/client";
import { listJobFiles } from "../../api/jobs";
import { listRepos, type RepoStatus } from "../../api/repos";
import { listSessions, type SessionInfo } from "../../api/sessions";
import { getState, type JobSummary, type StateResponse } from "../../api/state";
import { Card } from "../components/Card";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { formatRoute } from "../router";
import { describeWait, nextRunAt } from "../schedule";
import { useAsync } from "../useAsync";

/** Live status payload pushed by /api/jobs/events. */
interface LiveStatus {
  active: Set<string>;
  results: Record<string, { result: "ok" | "error" | "skipped" | "pass"; ranAt: number }>;
}

/**
 * Roll-up table of every scheduled job across all repos. Pulls together
 * what the various endpoints already know — there's no dedicated
 * /api/schedule yet, so we stitch it client-side:
 *
 *   - state.jobs    → name, schedule (cron), prompt
 *   - sessions      → last run timestamp & status (Running if a session is
 *                     open and was used in the last 5 min)
 *   - repo.plugins  → name → (slug, jobs-dir) so a row click opens the
 *                     right file editor under /ui/#/jobs/<slug>/<file>
 *   - listJobFiles  → fallback when the job lives outside a plugin
 */
export function ScheduleSection() {
  const state = useAsync<StateResponse>(() => getState());
  const repos = useAsync<RepoStatus[]>(() => listRepos());
  const sessions = useAsync<SessionInfo[]>(() => listSessions(true));

  // Build a name → (slug, path) lookup by walking each repo's file list.
  const fileMap = useAsync(async () => buildFileMap(repos.data ?? []), keyForRepos(repos.data));

  // Tick every second so the "in 4m 36s" countdown updates live.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Subscribe to /api/jobs/events for live status. The endpoint pushes a
  // snapshot every time a job transitions, plus an immediate snapshot on
  // connect, so we don't need to poll /api/state for status anymore.
  const [live, setLive] = useState<LiveStatus | null>(null);
  useEffect(() => {
    const token = getApiToken();
    const url = `/api/jobs/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(String(e.data)) as {
          type?: string;
          active?: string[];
          results?: LiveStatus["results"];
        };
        if (ev.type === "status") {
          setLive({
            active: new Set<string>(Array.isArray(ev.active) ? ev.active : []),
            results: typeof ev.results === "object" && ev.results ? ev.results : {},
          });
        }
      } catch {
        // ignore malformed frames
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => es.close();
  }, []);

  const rows = useMemo(
    () =>
      buildRows(
        state.data?.jobs ?? [],
        sessions.data ?? [],
        fileMap.data ?? new Map<string, { slug: string; path: string }>(),
        live,
      ),
    [state.data?.jobs, sessions.data, fileMap.data, live],
  );

  const [sort, setSort] = useState<Sort>({ column: "next", direction: "asc" });
  const sortedRows = useMemo(() => sortRows(rows, sort), [rows, sort]);

  const activeCount = rows.filter((r) => !!r.cron).length;
  const failedCount = rows.filter((r) => r.status === "failed").length;

  return (
    <>
      <PageHeader title="Schedule" crumbs={[{ label: "Schedule" }]} />

      <Card
        title={
          <span className="text-sm">
            <span className="font-semibold">{activeCount}</span> scheduled
            {failedCount > 0 && (
              <>
                {" · "}
                <span className="text-error">{failedCount} failed</span>
              </>
            )}
          </span>
        }
      >
        {(state.loading || repos.loading || sessions.loading) && <Loader />}
        {state.error ? <ErrorBanner error={state.error} /> : null}
        {repos.error ? <ErrorBanner error={repos.error} /> : null}
        {state.data && rows.length === 0 && <Empty>No scheduled jobs yet.</Empty>}

        {rows.length > 0 && (
          <>
            {/* Mobile: a stack of cards. Each row gets its own block with the
                Open button promoted to a full-width tap target. */}
            <ul className="md:hidden divide-y divide-base-300 -mx-2">
              {sortedRows.map((row) => {
                const canOpen = !!(row.slug && row.path);
                const href = canOpen
                  ? `${location.pathname}${formatRoute("jobs", [row.slug ?? "", row.path ?? ""])}`
                  : undefined;
                return (
                  <li
                    key={row.job.name}
                    className={`px-2 py-3 ${row.status === "running" ? "bg-base-200" : ""}`}
                  >
                    <div className="flex items-baseline justify-between gap-2 min-w-0">
                      {href ? (
                        <a href={href} className="font-mono font-medium truncate link link-primary">
                          {row.job.name}
                        </a>
                      ) : (
                        <span
                          className="font-mono font-medium truncate"
                          title="Definition not located"
                        >
                          {row.job.name}
                        </span>
                      )}
                      <StatusBadge status={row.status} />
                    </div>
                    <div className="text-sm truncate mt-0.5">{humanize(row.cron)}</div>
                    <div className="text-[11px] font-mono text-base-content/60 truncate">
                      {row.cron || "—"}
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-base-content/60 tabular-nums">
                      <div>
                        <div className="opacity-70">Last</div>
                        <div className="truncate">
                          {row.last ? new Date(row.last.lastUsedAt).toLocaleString() : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="opacity-70">Next</div>
                        <div className="truncate">
                          {row.next ? describeWait(row.next, now) : "—"}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Desktop: full table. */}
            <div className="hidden md:block overflow-x-auto -mx-2">
              <table className="table table-sm">
                <thead>
                  <tr className="text-xs uppercase text-base-content/60">
                    <SortableTh column="name" sort={sort} setSort={setSort}>
                      Job
                    </SortableTh>
                    <SortableTh column="cron" sort={sort} setSort={setSort}>
                      Schedule
                    </SortableTh>
                    <th>Status</th>
                    <SortableTh column="last" sort={sort} setSort={setSort}>
                      Last run
                    </SortableTh>
                    <SortableTh column="next" sort={sort} setSort={setSort}>
                      Next run
                    </SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <Row key={row.job.name} row={row} now={now} />
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

interface Row {
  job: JobSummary;
  /** Cron expression, "" if blank/event-only. */
  cron: string;
  human: string;
  next: Date | null;
  last: SessionInfo | null;
  status: "running" | "failed" | "idle" | "disabled";
  slug: string | null;
  path: string | null;
}

function buildRows(
  jobs: JobSummary[],
  sessions: SessionInfo[],
  fileMap: Map<string, { slug: string; path: string }>,
  live: LiveStatus | null,
): Row[] {
  return (
    jobs
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-row aggregation across four data sources; sequential branches, not nested logic worth factoring.
      .map((job) => {
        const matching = sessions.filter((s) => s.jobName === job.name);
        matching.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
        const last = matching[0] ?? null;
        const cron = (job.schedule ?? "").trim();
        const where = fileMap.get(job.name);
        // SSE snapshot overrides the values baked into the initial /api/state
        // response so the badge transitions without re-fetching.
        const running = live ? live.active.has(job.name) : (job.running ?? false);
        const lastResult = live
          ? (live.results[job.name]?.result ?? null)
          : (job.lastResult ?? null);
        let status: Row["status"];
        if (running) {
          status = "running";
        } else if (lastResult === "error") {
          status = "failed";
        } else if (cron) {
          status = "idle";
        } else {
          status = "disabled";
        }
        return {
          job,
          cron,
          human: cron || "—",
          next: cron ? nextRunAt(cron) : null,
          last,
          status,
          slug: where?.slug ?? null,
          path: where?.path ?? null,
        };
      })
      .sort((a, b) => a.job.name.localeCompare(b.job.name))
  );
}

function Row({ row, now }: { row: Row; now: Date }) {
  const { job, cron, next, last, status, slug, path } = row;
  const href =
    slug && path ? `${location.pathname}${formatRoute("jobs", [slug, path])}` : undefined;
  return (
    <tr className={status === "running" ? "bg-base-200" : ""}>
      <td className="max-w-[14rem]">
        {href ? (
          <a href={href} className="font-mono font-medium truncate link link-primary">
            {job.name}
          </a>
        ) : (
          <span className="font-mono font-medium truncate" title="Definition not located">
            {job.name}
          </span>
        )}
        {job.prompt && (
          <div className="text-xs text-base-content/60 truncate">
            {job.prompt.replace(/\s+/g, " ").slice(0, 60)}
          </div>
        )}
      </td>
      <td className="max-w-[12rem]">
        <div className="text-sm truncate">{humanize(cron)}</div>
        <div className="text-[11px] font-mono text-base-content/60 truncate">{cron || "—"}</div>
      </td>
      <td>
        <StatusBadge status={status} />
      </td>
      <td className="text-xs text-base-content/70 tabular-nums">
        {last ? new Date(last.lastUsedAt).toLocaleString() : "—"}
      </td>
      <td className="text-xs text-base-content/70 tabular-nums">
        {next ? (
          <>
            <div>{next.toLocaleString()}</div>
            <div className="text-base-content/50">{describeWait(next, now)}</div>
          </>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortColumn = "name" | "cron" | "last" | "next";
interface Sort {
  column: SortColumn;
  direction: "asc" | "desc";
}

/** Sort rows by the chosen column. Nulls (missing timestamps) always land
 *  at the end of the list regardless of direction. */
function sortRows(rows: Row[], { column, direction }: Sort): Row[] {
  const sign = direction === "asc" ? 1 : -1;
  const nullsLast = (a: number | null, b: number | null): number => {
    if (a === null && b === null) {
      return 0;
    }
    if (a === null) {
      return 1;
    }
    if (b === null) {
      return -1;
    }
    return (a - b) * sign;
  };
  return [...rows].sort((a, b) => {
    if (column === "name") {
      return a.job.name.localeCompare(b.job.name) * sign;
    }
    if (column === "cron") {
      return a.cron.localeCompare(b.cron) * sign;
    }
    if (column === "last") {
      return nullsLast(
        a.last ? new Date(a.last.lastUsedAt).getTime() : null,
        b.last ? new Date(b.last.lastUsedAt).getTime() : null,
      );
    }
    return nullsLast(a.next?.getTime() ?? null, b.next?.getTime() ?? null);
  });
}

function SortableTh({
  column,
  sort,
  setSort,
  children,
}: {
  column: SortColumn;
  sort: Sort;
  setSort: (s: Sort) => void;
  children: React.ReactNode;
}) {
  const active = sort.column === column;
  return (
    <th>
      <button
        type="button"
        className={`inline-flex items-center gap-1 uppercase text-xs ${
          active ? "text-base-content" : "text-base-content/60 hover:text-base-content"
        }`}
        onClick={() =>
          setSort({
            column,
            direction: active && sort.direction === "asc" ? "desc" : "asc",
          })
        }
      >
        {children}
        {active && (sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );
}

function StatusBadge({ status }: { status: Row["status"] }) {
  if (status === "running") {
    return (
      <span className="badge badge-info gap-1">
        <span className="loading loading-spinner loading-xs" />
        Running
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="badge badge-error gap-1">
        <AlertTriangle size={12} /> Failed
      </span>
    );
  }
  if (status === "disabled") {
    return (
      <span className="badge badge-ghost gap-1">
        <CircleOff size={12} /> Disabled
      </span>
    );
  }
  return (
    <span className="badge badge-ghost gap-1">
      <Pause size={12} /> Idle
    </span>
  );
}

function humanize(cron: string): string {
  if (!cron) {
    return "Event / manual";
  }
  // Cheap shortcuts for the common shapes we emit; cronstrue is in the
  // editor for everything else, but the table renders enough rows that
  // we'd rather not import it here.
  if (cron === "* * * * *") {
    return "Every minute";
  }
  const everyN = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (everyN) {
    return `Every ${everyN[1]} minutes`;
  }
  if (cron === "0 * * * *") {
    return "Every hour";
  }
  const everyH = /^0 \*\/(\d+) \* \* \*$/.exec(cron);
  if (everyH) {
    return `Every ${everyH[1]} hours`;
  }
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (daily) {
    return `Daily at ${pad(daily[2])}:${pad(daily[1])}`;
  }
  const weekly = /^(\d+) (\d+) \* \* (\d+)$/.exec(cron);
  if (weekly) {
    return `${DOW[Number(weekly[3]) % 7]} at ${pad(weekly[2])}:${pad(weekly[1])}`;
  }
  return cron;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(s: string | undefined): string {
  return (s ?? "0").padStart(2, "0");
}

function keyForRepos(repos: RepoStatus[] | null): string {
  if (!repos) {
    return "";
  }
  return repos.map((r) => r.slug).join(",");
}

async function buildFileMap(
  repos: RepoStatus[],
): Promise<Map<string, { slug: string; path: string }>> {
  const map = new Map<string, { slug: string; path: string }>();
  for (const repo of repos) {
    try {
      const files = await listJobFiles(repo.slug);
      for (const f of files) {
        if (!f.path.endsWith(".md")) {
          continue;
        }
        const stem = f.path.replace(/\.md$/, "");
        if (!map.has(stem)) {
          map.set(stem, { slug: repo.slug, path: f.path });
        }
      }
    } catch {
      // skip repos that error out; row just won't be openable.
    }
  }
  return map;
}
