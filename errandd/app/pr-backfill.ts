/**
 * Reconcile queue-known PRs missing from fresh open lists. Merged is immutable;
 * closed and unresolvable records need bounded revalidation because reopening
 * or restored access may happen while webhook delivery is unavailable.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { derivePrStateFromGraphql, type PrStateGraphqlFields } from "../shared/prState";
import { getHookQueue } from "./hookQueue";
import {
  getPrState,
  getPrStateRevision,
  prStateKey,
  recordPrState,
  prSourceUpdatedAtMs,
} from "./pr-state";

const execFileAsync = promisify(execFile);

/** GraphQL aliases must be identifiers, so PR 123 is selected as `p123`. */
const ALIAS_PREFIX = "p";

/** Nodes per query. GitHub caps aliased selections well above this. */
const BATCH_SIZE = 50;

/** Batches per cycle, so a first boot with a big backlog spreads over cycles. */
const MAX_BATCHES_PER_CYCLE = 2;

const REVALIDATE_AFTER_MS = 5 * 60 * 1000;
/** Retry metadata is bounded to the queue-known working set. */
const retryAtMs = new Map<string, number>();

/** Every `repo#num` the hook queue has ever recorded, newest rows first. */
function knownPrsByRepo(): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  try {
    for (const row of getHookQueue().listLatestPerThread(500)) {
      if (!row.prRepo || row.prNumber == null) {
        continue;
      }
      let numbers = out.get(row.prRepo);
      if (!numbers) {
        numbers = new Set();
        out.set(row.prRepo, numbers);
      }
      numbers.add(row.prNumber);
    }
  } catch {
    // queue unavailable — nothing to backfill
  }
  return out;
}

/** Batched `pullRequest(number:)` lookup. Returns the nodes GitHub resolved. */
async function fetchPrNodes(
  repo: string,
  numbers: number[],
  timeoutMs = 30_000,
): Promise<Map<number, PrStateGraphqlFields>> {
  const [owner, name] = repo.split("/");
  const resolved = new Map<number, PrStateGraphqlFields>();
  if (!owner || !name) {
    return resolved;
  }

  const selections = numbers
    .map(
      (n) => `${ALIAS_PREFIX}${n}: pullRequest(number: ${n}) { state isDraft mergeable updatedAt }`,
    )
    .join("\n");
  const query = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
${selections}
  }
}`;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "gh",
      ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (e) {
    // A partial GraphQL response (e.g. one NOT_FOUND alias among many) exits
    // non-zero but still carries `data` on stdout — salvage it rather than
    // throwing away 49 good answers.
    stdout = (e as { stdout?: string }).stdout ?? "";
    if (!stdout) {
      throw e;
    }
  }

  const parsed = JSON.parse(stdout) as { data?: { repository?: Record<string, unknown> | null } };
  const repository = parsed.data?.repository;
  if (!repository) {
    return resolved;
  }
  for (const n of numbers) {
    const node = repository[`${ALIAS_PREFIX}${n}`];
    if (typeof node === "object" && node !== null) {
      resolved.set(n, node);
    }
  }
  return resolved;
}

/**
 * Resolve the state of queue-known PRs that are absent from a fresh open list.
 *
 * `freshlyOpen` maps repo → open PR numbers, and must only contain repos whose
 * last poll succeeded recently; a repo missing from it is skipped entirely.
 */
export async function backfillClosedPrStates(
  freshlyOpen: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<void> {
  const known = knownPrsByRepo();
  const knownKeys = new Set(
    [...known].flatMap(([repo, numbers]) => [...numbers].map((n) => prStateKey(repo, n))),
  );
  for (const key of retryAtMs.keys()) if (!knownKeys.has(key)) retryAtMs.delete(key);
  const nowMs = Date.now();
  const eligible: { repo: string; number: number; retryAtMs: number }[] = [];
  for (const [repo, openNumbers] of freshlyOpen) {
    for (const number of known.get(repo) ?? []) {
      const key = prStateKey(repo, number);
      if (openNumbers.has(number) || getPrState(key)?.state === "merged") {
        retryAtMs.delete(key);
        continue;
      }
      const retryAt = retryAtMs.get(key) ?? 0;
      if (retryAt <= nowMs) eligible.push({ repo, number, retryAtMs: retryAt });
    }
  }
  // Spend the bounded query budget on the oldest attempts across all repositories.
  eligible.sort((a, b) => a.retryAtMs - b.retryAtMs);
  const pending: { repo: string; numbers: number[] }[] = [];
  while (eligible.length > 0 && pending.length < MAX_BATCHES_PER_CYCLE) {
    const repo = eligible[0].repo;
    const numbers: number[] = [];
    for (let i = 0; i < eligible.length && numbers.length < BATCH_SIZE; ) {
      if (eligible[i].repo === repo) numbers.push(eligible.splice(i, 1)[0].number);
      else i++;
    }
    pending.push({ repo, numbers });
  }

  for (const batch of pending) {
    let nodes: Map<number, PrStateGraphqlFields>;
    const startedRevision = getPrStateRevision();
    try {
      nodes = await fetchPrNodes(batch.repo, batch.numbers);
    } catch {
      for (const n of batch.numbers)
        retryAtMs.set(prStateKey(batch.repo, n), Date.now() + REVALIDATE_AFTER_MS);
      return;
    }
    for (const n of batch.numbers) {
      const key = prStateKey(batch.repo, n);
      retryAtMs.set(key, Date.now() + REVALIDATE_AFTER_MS);
      const node = nodes.get(n);
      const state = derivePrStateFromGraphql(node);
      if (state === "unknown") continue;
      const mergeable =
        typeof node?.mergeable === "string" && node.mergeable.toUpperCase() !== "UNKNOWN"
          ? node.mergeable.toUpperCase() === "MERGEABLE"
          : null;
      recordPrState(
        batch.repo,
        n,
        { state, mergeable, sourceUpdatedAtMs: prSourceUpdatedAtMs(node?.updatedAt) },
        startedRevision,
      );
      if (getPrState(key)?.state === "merged") retryAtMs.delete(key);
    }
  }
}

/** Test-only: clear reconciliation retry scheduling. */
export function __resetPrBackfillForTest(): void {
  retryAtMs.clear();
}
