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
import { getHookQueue } from "./hookQueue";
import { recentDeliveries } from "./hooks/deliveries";

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

/** Runs one poll cycle across all derived repos. Best-effort per repo. */
export async function pollOpenPRs(): Promise<void> {
  const repos = deriveRepos();
  if (repos.length === 0) {
    return;
  }

  await Promise.allSettled(
    repos.map(async (repo) => {
      try {
        const prs = await fetchRepoPRs(repo);
        cache.set(repo, { prs, fetchedAt: Date.now() });
      } catch {
        // leave stale cache entry in place — best-effort
      }
    }),
  );
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
