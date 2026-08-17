/**
 * PR reconciliation poller
 *
 * Polls `gh pr list` for repos seen in recent hook-queue rows and the
 * deliveries ring, caches results in memory, and serves them via
 * GET /api/prs/open. This lets the sidebar surface ALL open PRs, not only
 * those that generated a queued webhook event.
 *
 * Best-effort: one repo failing does not break others; gh absence / empty
 * repo-derive is a silent no-op. Results survive until the next poll cycle.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrGitState } from "../shared/prState";
import { getHookQueue } from "./hookQueue";
import { recentDeliveries } from "./hooks/deliveries";
import { backfillClosedPrStates } from "./pr-backfill";

const execFileAsync = promisify(execFile);

export interface PolledPR {
  repo: string;
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  updatedAt: string; // ISO string
  labels: string[];
}

interface RepoPRs {
  prs: PolledPR[];
  fetchedAt: number; // Date.now()
}

/** Module singleton cache: repo → RepoPRs */
const cache = new Map<string, RepoPRs>();

/** Returns all repos seen in recent queue rows + the deliveries ring. */
function deriveRepos(): string[] {
  const repos = new Set<string>();

  // From hook queue (covers PRs with any webhook history)
  try {
    const rows = getHookQueue().listLatestPerThread(500);
    for (const row of rows) {
      if (row.prRepo) {
        repos.add(row.prRepo);
      }
    }
  } catch {
    // queue unavailable — skip
  }

  // From deliveries ring (GitHub payloads carry repository.full_name)
  try {
    for (const d of recentDeliveries()) {
      if (d.source === "github") {
        const payload = d.payload as Record<string, unknown> | undefined;
        const repoName = (payload?.repository as Record<string, unknown> | undefined)?.full_name;
        if (typeof repoName === "string" && repoName.includes("/")) {
          repos.add(repoName);
        }
      }
    }
  } catch {
    // ring unavailable — skip
  }

  return [...repos];
}

/** Fetches open PRs for one repo using `gh pr list`. Throws on failure. */
async function fetchRepoPRs(repo: string, timeoutMs = 30_000): Promise<PolledPR[]> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,author,isDraft,updatedAt,labels",
    ],
    { timeout: timeoutMs },
  );
  const raw = JSON.parse(stdout) as {
    number: number;
    title: string;
    author: { login: string };
    isDraft: boolean;
    updatedAt: string;
    labels: { name: string }[];
  }[];
  return raw.map((pr) => ({
    repo,
    number: pr.number,
    title: pr.title,
    author: pr.author?.login ?? "",
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    labels: (pr.labels ?? []).map((l) => l.name),
  }));
}

/**
 * Only poll GitHub while something is actually reading the result. The cache
 * exists solely to render the sidebar, so a daemon with no dashboard open has
 * no reason to spend GitHub quota every 3 minutes — `/api/prs/open` marks
 * demand on each request, and the UI re-polls well inside this window.
 */
const DEMAND_WINDOW_MS = 15 * 60 * 1000;
let lastDemandAt = 0;

/** Called by GET /api/prs/open: someone is watching, so keep polling. */
export function markOpenPRsDemand(): void {
  lastDemandAt = Date.now();
}

/**
 * Per-repo failure backoff. A repo that 503s (or hits a secondary rate limit)
 * is the last thing that should be retried on a fixed 3-minute drumbeat, so
 * each consecutive failure doubles its skip window up to 30 minutes; one
 * success clears it.
 */
const BACKOFF_BASE_MS = 3 * 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const backoff = new Map<string, { until: number; failures: number }>();

function noteFailure(repo: string, now: number): void {
  const failures = (backoff.get(repo)?.failures ?? 0) + 1;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** failures);
  backoff.set(repo, { until: now + delay, failures });
}

/** In-flight cycle, so a burst of dashboard loads can't stack poll cycles. */
let inFlight: Promise<void> | null = null;

/**
 * Runs one poll cycle across all derived repos. Best-effort per repo, skipped
 * entirely when nobody has asked for the list recently. Pass `force` to poll
 * regardless (the API route does this when a reader finds the cache empty).
 */
export async function pollOpenPRs(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastDemandAt > DEMAND_WINDOW_MS) {
    return;
  }
  if (inFlight) {
    return inFlight;
  }

  const repos = deriveRepos().filter((repo) => (backoff.get(repo)?.until ?? 0) <= now);
  if (repos.length === 0) {
    return;
  }

  inFlight = (async () => {
    await Promise.allSettled(
      repos.map(async (repo) => {
        try {
          const prs = await fetchRepoPRs(repo);
          cache.set(repo, { prs, fetchedAt: Date.now() });
          backoff.delete(repo);
        } catch {
          // leave stale cache entry in place — best-effort
          noteFailure(repo, Date.now());
        }
      }),
    );
    // Anything the queue knows about that is NOT in a *fresh* open list has
    // closed or merged; resolve those once, off the back of the same cycle.
    // Repos whose fetch just failed are excluded — a stale cache must never be
    // read as "these PRs are gone".
    const staleCutoff = Date.now() - 10 * 60 * 1000;
    const freshlyOpen = new Map<string, Set<number>>();
    for (const [repo, entry] of cache) {
      if (entry.fetchedAt >= staleCutoff) {
        freshlyOpen.set(repo, new Set(entry.prs.map((pr) => pr.number)));
      }
    }
    await backfillClosedPrStates(freshlyOpen).catch(() => {});
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * `repo#num` → "draft" | "open" for every PR in the last successful poll.
 * Free state for the sidebar: `gh pr list --state open` already told us both
 * facts, so no extra GitHub call is needed to render open-vs-draft.
 */
export function getPolledPrStates(): Record<string, PrGitState> {
  const out: Record<string, PrGitState> = {};
  for (const entry of cache.values()) {
    for (const pr of entry.prs) {
      out[`${pr.repo}#${pr.number}`] = pr.isDraft ? "draft" : "open";
    }
  }
  return out;
}

/** Returns the current cache as a flat list of PRs + the latest fetch time. */
export function getCachedOpenPRs(): { prs: PolledPR[]; fetchedAt: number } {
  const all: PolledPR[] = [];
  let fetchedAt = 0;
  for (const entry of cache.values()) {
    all.push(...entry.prs);
    if (entry.fetchedAt > fetchedAt) {
      fetchedAt = entry.fetchedAt;
    }
  }
  return { prs: all, fetchedAt };
}
