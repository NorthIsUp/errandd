import { useMemo, useState } from "react";
import { listJobFiles } from "../../api/jobs";
import { listRepos, type RepoStatus } from "../../api/repos";
import type { SessionUsage } from "../../api/usage";
import { getUsage } from "../../api/usage";
import { Card } from "../components/Card";
import { Disclosure } from "../components/Disclosure";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { type Bucket, TimeChart } from "../components/TimeChart";
import { useAsync } from "../useAsync";

export function HomeSection() {
  const usage = useAsync<SessionUsage[]>(() => getUsage());
  const repos = useAsync<RepoStatus[]>(() => listRepos());
  const fileMap = useAsync(async () => buildJobRepoMap(repos.data ?? []), keyForRepos(repos.data));

  return (
    <>
      <PageHeader title="Home" crumbs={[{ label: "Home" }]} />

      <Card title="Usage over time">
        {usage.loading && <Loader label="Loading usage…" />}
        {usage.error ? <ErrorBanner error={usage.error} /> : null}
        {usage.data && <UsageOverTime sessions={usage.data} />}
      </Card>

      <Card title="By jobs repo">
        {(usage.loading || repos.loading || fileMap.loading) && <Loader />}
        {usage.error ? <ErrorBanner error={usage.error} /> : null}
        {repos.error ? <ErrorBanner error={repos.error} /> : null}
        {usage.data && <ByJobsRepo sessions={usage.data} jobToRepo={fileMap.data ?? new Map()} />}
      </Card>

      <Card title="Token usage">
        {usage.loading && <Loader />}
        {usage.error ? <ErrorBanner error={usage.error} /> : null}
        {usage.data && <UsageTable sessions={usage.data} />}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Time-bucketed chart with Day / Week / Month toggle
// ---------------------------------------------------------------------------

function UsageOverTime({ sessions }: { sessions: SessionUsage[] }) {
  const [bucket, setBucket] = useState<Bucket>("day");
  if (sessions.length === 0) {
    return <Empty>No usage yet.</Empty>;
  }
  return (
    <div className="space-y-3">
      <div role="radiogroup" className="join self-start">
        {(["day", "week", "month"] as Bucket[]).map((b) => (
          // biome-ignore lint/a11y/useSemanticElements: <input type="radio"> can't take daisyUI .btn styling
          <button
            key={b}
            type="button"
            role="radio"
            aria-checked={bucket === b}
            onClick={() => setBucket(b)}
            className={`btn btn-xs join-item capitalize ${bucket === b ? "btn-primary" : ""}`}
          >
            {b}
          </button>
        ))}
      </div>
      <TimeChart sessions={sessions} bucket={bucket} />
      <Legend />
    </div>
  );
}

function Legend() {
  const items: { label: string; cls: string }[] = [
    { label: "input", cls: "bg-primary" },
    { label: "output", cls: "bg-secondary" },
    { label: "cache read", cls: "bg-accent/70" },
    { label: "cache write", cls: "bg-info/60" },
  ];
  return (
    <div className="flex flex-wrap gap-3 pt-1 text-xs text-base-content/70">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={`w-3 h-3 rounded-sm ${i.cls}`} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs-repo breakdown — group each session's usage by the repo its job lives
// in. The session→job link comes from the label (threadId, of the form
// "<jobName>:<runId>"); the job→repo link comes from walking each repo's job
// files (same trick the Schedule tab uses). Sessions without a job
// (label === "global" or "web") land in a single "Web / chat / other" bucket;
// sessions whose job no longer exists in any configured repo go to "ad-hoc".
// ---------------------------------------------------------------------------

const OTHER_BUCKET = "Web / chat / other";
const AD_HOC_BUCKET = "ad-hoc";

function bucketFor(s: SessionUsage, jobToRepo: Map<string, string>): string {
  const label = s.label || "";
  // Global web session, or thread labels that explicitly mark non-job channels.
  if (label === "global" || label === "web" || s.channel === "web") {
    return OTHER_BUCKET;
  }
  // Job-thread labels look like "<jobName>:<runId>". Strip the run id.
  const jobName = label.split(":")[0] || label;
  if (!jobName) {
    return AD_HOC_BUCKET;
  }
  const slug = jobToRepo.get(jobName);
  return slug ?? AD_HOC_BUCKET;
}

function ByJobsRepo({
  sessions,
  jobToRepo,
}: {
  sessions: SessionUsage[];
  jobToRepo: Map<string, string>;
}) {
  const rows = useMemo(() => {
    const map = new Map<string, { total: number; cost: number; sessions: number }>();
    for (const s of sessions) {
      const k = bucketFor(s, jobToRepo);
      const r = map.get(k) ?? { total: 0, cost: 0, sessions: 0 };
      r.total += s.inputTokens + s.outputTokens;
      r.cost += s.estimatedCostUsd;
      r.sessions += 1;
      map.set(k, r);
    }
    return [...map.entries()]
      .map(([k, v]) => ({ bucket: k, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [sessions, jobToRepo]);

  if (rows.length === 0) {
    return <Empty>No sessions yet.</Empty>;
  }
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.bucket} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">{r.bucket}</span>
            <span className="tabular-nums text-xs text-base-content/70">
              {r.total.toLocaleString()} tok · {`$${r.cost.toFixed(3)}`} · {r.sessions} session
              {r.sessions === 1 ? "" : "s"}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-base-200">
            <div
              className="h-full bg-primary"
              style={{ width: `${(r.total / maxTotal) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Repo helpers — mirror buildFileMap in ScheduleSection, but we only need
// the slug per job-name stem (not the full path).
// ---------------------------------------------------------------------------

function keyForRepos(repos: RepoStatus[] | null): string {
  if (!repos) {
    return "";
  }
  return repos.map((r) => r.slug).join(",");
}

async function buildJobRepoMap(repos: RepoStatus[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const repo of repos) {
    try {
      const files = await listJobFiles(repo.slug);
      for (const f of files) {
        if (!f.path.endsWith(".md")) {
          continue;
        }
        const stem = f.path.replace(/\.md$/, "").split("/").pop() ?? "";
        if (stem && !map.has(stem)) {
          map.set(stem, repo.slug);
        }
      }
    } catch {
      // skip repos that error out; their jobs will fall into "ad-hoc".
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Token usage table — narrow two-line rows; jobs aggregated into a single
// "Jobs" total row that discloses individual jobs.
// ---------------------------------------------------------------------------

interface Row {
  key: string;
  label: string;
  sessions: SessionUsage[];
  total: number;
  cost: number;
}

function UsageTable({ sessions }: { sessions: SessionUsage[] }) {
  if (sessions.length === 0) {
    return <Empty>No sessions yet.</Empty>;
  }

  const totals = sessions.reduce(
    (acc, s) => {
      acc.input += s.inputTokens;
      acc.output += s.outputTokens;
      acc.cacheR += s.cacheReadTokens;
      acc.cacheW += s.cacheWriteTokens;
      acc.cost += s.estimatedCostUsd;
      return acc;
    },
    { input: 0, output: 0, cacheR: 0, cacheW: 0, cost: 0 },
  );
  // Excludes cache read/write — those are discounted context re-sends, not new work.
  const grand = totals.input + totals.output;

  // Group by job name (label before the ":run-id" suffix); fall back to
  // channel for sessions without a job label.
  const byJob = new Map<string, Row>();
  for (const s of sessions) {
    const rawLabel = s.label || s.channel || "unknown";
    const key = rawLabel.split(":")[0] || rawLabel;
    let row = byJob.get(key);
    if (!row) {
      row = { key, label: key, sessions: [], total: 0, cost: 0 };
      byJob.set(key, row);
    }
    row.sessions.push(s);
    row.total += s.inputTokens + s.outputTokens;
    row.cost += s.estimatedCostUsd;
  }
  // Sort runs within each job, newest first.
  for (const row of byJob.values()) {
    row.sessions.sort((a, b) =>
      a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0,
    );
  }
  const allRows = [...byJob.values()].sort((a, b) => b.total - a.total);
  const jobRows = allRows.filter((r) => r.label !== "global" && r.label !== "web");
  const nonJobRows = allRows.filter((r) => r.label === "global" || r.label === "web");

  const jobsTotal = jobRows.reduce((a, r) => a + r.total, 0);
  const jobsCost = jobRows.reduce((a, r) => a + r.cost, 0);
  const jobsSessions = jobRows.reduce((a, r) => a + r.sessions.length, 0);

  return (
    <div className="space-y-3">
      <div className="stats stats-vertical sm:stats-horizontal shadow-sm bg-base-200 w-full">
        <Stat label="Total tokens" value={grand.toLocaleString()} />
        <Stat label="Input" value={totals.input.toLocaleString()} />
        <Stat label="Output" value={totals.output.toLocaleString()} />
        <Stat label="Cache" value={(totals.cacheR + totals.cacheW).toLocaleString()} />
        <Stat label="Cost" value={`$${totals.cost.toFixed(3)}`} />
      </div>

      <div className="space-y-2">
        {nonJobRows.map((r) => (
          <RowDisclosure key={r.key} row={r} />
        ))}

        {jobRows.length > 0 && (
          <Disclosure
            summary={
              <RowSummary
                label={`All jobs (${jobRows.length})`}
                total={jobsTotal}
                cost={jobsCost}
                sessions={jobsSessions}
                emphasis
              />
            }
          >
            <div className="space-y-2">
              {jobRows.map((r) => (
                <RowDisclosure key={r.key} row={r} />
              ))}
            </div>
          </Disclosure>
        )}
      </div>
    </div>
  );
}

function RowDisclosure({ row }: { row: Row }) {
  return (
    <Disclosure
      summary={
        <RowSummary
          label={row.label}
          total={row.total}
          cost={row.cost}
          sessions={row.sessions.length}
        />
      }
    >
      <div className="overflow-x-auto -mx-1">
        <table className="table table-xs">
          <thead>
            <tr>
              <th>Run</th>
              <th className="text-right">Input</th>
              <th className="text-right">Output</th>
              <th className="text-right">Cache R/W</th>
              <th className="text-right">Cost</th>
              <th className="text-right">Turns</th>
            </tr>
          </thead>
          <tbody>
            {row.sessions.map((s) => (
              <tr key={s.sessionId} title={s.sessionId}>
                <td className="font-mono text-[11px] whitespace-nowrap">
                  {formatRun(s.lastUsedAt)}
                </td>
                <td className="text-right tabular-nums">{s.inputTokens.toLocaleString()}</td>
                <td className="text-right tabular-nums">{s.outputTokens.toLocaleString()}</td>
                <td className="text-right tabular-nums">
                  {s.cacheReadTokens.toLocaleString()}/{s.cacheWriteTokens.toLocaleString()}
                </td>
                <td className="text-right tabular-nums">${s.estimatedCostUsd.toFixed(3)}</td>
                <td className="text-right tabular-nums">{s.turnCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Disclosure>
  );
}

function RowSummary({
  label,
  total,
  cost,
  sessions,
  emphasis,
}: {
  label: string;
  total: number;
  cost: number;
  sessions: number;
  emphasis?: boolean;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-y-0.5 sm:gap-3 min-w-0">
      <span className={`truncate ${emphasis ? "font-semibold" : "font-medium"}`}>{label}</span>
      <span className="tabular-nums text-xs text-base-content/70 shrink-0">
        {total.toLocaleString()} tok · {`$${cost.toFixed(3)}`} · {sessions} session
        {sessions === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function formatRun(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat py-2">
      <div className="stat-title text-xs">{label}</div>
      <div className="stat-value text-lg tabular-nums">{value}</div>
    </div>
  );
}
