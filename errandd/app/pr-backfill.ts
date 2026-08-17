/**
 * One-shot resolution of merged-vs-closed for PRs the queue knows about.
 *
 * The reconciliation poller only lists `--state open`, and the webhook store
 * only learns a PR merged if the daemon happened to be up when the event
 * arrived — so every historical PR in the sidebar rendered as the neutral
 * "unknown" icon. This closes that gap without adding a recurring cost: a PR
 * the queue knows about that is absent from a *fresh* open list has ended, and
 * `merged`/`closed` never change again, so one batched GraphQL query per ~50
 * such PRs resolves them permanently.
 *
 * Cheap by construction: aliased `pullRequest(number:)` nodes cost 1 point per
 * query regardless of batch size, results are recorded in the pr-state store
 * (which the poller then never re-asks about), and unresolvable numbers are
 * remembered so a deleted/transferred PR can't loop forever.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { derivePrStateFromGraphql, isTerminalPrState } from "../shared/prState";
import { getHookQueue } from "./hookQueue";
import { getPrState, prStateKey, recordPrState } from "./pr-state";

const execFileAsync = promisify(execFile);

/** GraphQL aliases must be identifiers, so PR 123 is selected as `p123`. */
const ALIAS_PREFIX = "p";

/** Nodes per query. GitHub caps aliased selections well above this. */
const BATCH_SIZE = 50;

/** Batches per cycle, so a first boot with a big backlog spreads over cycles. */
const MAX_BATCHES_PER_CYCLE = 2;

/** PRs GitHub couldn't resolve (deleted, transferred, no access) — asked once. */
const unresolvable = new Set<string>();

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

interface GraphqlPrNode {
  state?: unknown;
  isDraft?: unknown;
  mergeable?: unknown;
}

/** Batched `pullRequest(number:)` lookup. Returns the nodes GitHub resolved. */
async function fetchPrNodes(
  repo: string,
  numbers: number[],
  timeoutMs = 30_000,
): Promise<Map<number, GraphqlPrNode>> {
  const [owner, name] = repo.split("/");
  const resolved = new Map<number, GraphqlPrNode>();
  if (!owner || !name) {
    return resolved;
  }

  const selections = numbers
    .map((n) => `${ALIAS_PREFIX}${n}: pullRequest(number: ${n}) { state isDraft mergeable }`)
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
  const pending: { repo: string; numbers: number[] }[] = [];

  for (const [repo, openNumbers] of freshlyOpen) {
    const numbers = [...(known.get(repo) ?? [])].filter((n) => {
      if (openNumbers.has(n)) {
        return false;
      }
      const key = prStateKey(repo, n);
      if (unresolvable.has(key)) {
        return false;
      }
      const current = getPrState(key);
      return !(current && isTerminalPrState(current.state));
    });
    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
      pending.push({ repo, numbers: numbers.slice(i, i + BATCH_SIZE) });
    }
  }

  for (const batch of pending.slice(0, MAX_BATCHES_PER_CYCLE)) {
    let nodes: Map<number, GraphqlPrNode>;
    try {
      nodes = await fetchPrNodes(batch.repo, batch.numbers);
    } catch {
      return; // GitHub is unhappy — stop this cycle, retry on the next one
    }
    for (const n of batch.numbers) {
      const node = nodes.get(n);
      const state = derivePrStateFromGraphql(node);
      if (state === "unknown") {
        unresolvable.add(prStateKey(batch.repo, n));
        continue;
      }
      const mergeable =
        typeof node?.mergeable === "string" && node.mergeable.toUpperCase() !== "UNKNOWN"
          ? node.mergeable.toUpperCase() === "MERGEABLE"
          : null;
      recordPrState(batch.repo, n, { state, mergeable });
    }
  }
}

/** Test-only: forget which PRs GitHub refused to resolve. */
export function __resetPrBackfillForTest(): void {
  unresolvable.clear();
}
