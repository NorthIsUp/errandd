/**
 * Per-PR git-state store, fed by the GitHub webhook hook pipeline.
 *
 * `dispatchHook` (app/hooks/github.ts) calls `recordPrStateFromWebhook` on every
 * `pull_request` event, regardless of whether any routine subscribes — so the
 * daemon accumulates the live open/merged/closed/conflicted state of every PR it
 * hears about. The sidebar reads it via GET /api/prs/open and renders a per-PR
 * icon. In-memory + best-effort: it resets on restart (the reconciliation poller
 * re-seeds "open" for live PRs; merged/closed re-populate as new events arrive).
 */
import { derivePrState, type PrGitState, type PrStateInfo } from "../shared/prState";

interface PrStateEntry extends PrStateInfo {
  /** Date.now() of the last event that updated this entry. */
  updatedAt: number;
}

/** repo#number → latest known state. */
const store = new Map<string, PrStateEntry>();

/** Canonical store key — matches the sidebar's TreeItem key (`repo#num`). */
export function prStateKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/** Read `repository.full_name` (or owner/name) + PR number from a webhook body. */
function readPrIdentity(payload: unknown): { repo: string; prNumber: number } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const pr = root.pull_request;
  const repoObj = root.repository;
  if (typeof pr !== "object" || pr === null || typeof repoObj !== "object" || repoObj === null) {
    return null;
  }
  const prObj = pr as Record<string, unknown>;
  const repoR = repoObj as Record<string, unknown>;

  const num = typeof prObj.number === "number" ? prObj.number : Number(prObj.number);
  if (!Number.isFinite(num)) {
    return null;
  }

  let repo: string | null = typeof repoR.full_name === "string" ? repoR.full_name : null;
  if (!repo) {
    const owner = repoR.owner;
    const ownerLogin =
      typeof owner === "object" && owner !== null
        ? (owner as Record<string, unknown>).login
        : undefined;
    if (typeof ownerLogin === "string" && typeof repoR.name === "string") {
      repo = `${ownerLogin}/${repoR.name}`;
    }
  }
  if (!repo?.includes("/")) {
    return null;
  }
  return { repo, prNumber: num };
}

/**
 * Record PR git-state from a `pull_request` webhook payload. Never throws.
 *
 * An event we can't classify (`derivePrState` → "unknown") does NOT clobber a
 * previously-known state — a `labeled`/`edited` event with no mergeability info
 * shouldn't wipe a known "conflicted". Returns the stored entry (or the retained
 * prior one), or null when the payload isn't a usable PR event.
 */
export function recordPrStateFromWebhook(payload: unknown): PrStateInfo | null {
  const ident = readPrIdentity(payload);
  if (!ident) {
    return null;
  }
  const prObj = (payload as Record<string, unknown>).pull_request as Record<string, unknown>;
  const key = prStateKey(ident.repo, ident.prNumber);
  const derived: PrGitState = derivePrState(prObj);
  if (derived === "unknown") {
    return store.get(key) ?? null;
  }
  const mergeable = typeof prObj.mergeable === "boolean" ? prObj.mergeable : null;
  const entry: PrStateEntry = { state: derived, mergeable, updatedAt: Date.now() };
  store.set(key, entry);
  return { state: entry.state, mergeable: entry.mergeable };
}

/** Record a state resolved outside the webhook path (see app/pr-backfill.ts). */
export function recordPrState(repo: string, prNumber: number, info: PrStateInfo): void {
  store.set(prStateKey(repo, prNumber), { ...info, updatedAt: Date.now() });
}

/** Latest known state for a `repo#number` key, or null when we've never seen it. */
export function getPrState(key: string): PrStateInfo | null {
  const entry = store.get(key);
  return entry ? { state: entry.state, mergeable: entry.mergeable } : null;
}

/** Snapshot of all known PR states keyed by `repo#number`, for the API. */
export function getPrStates(): Record<string, PrStateInfo> {
  const out: Record<string, PrStateInfo> = {};
  for (const [key, entry] of store) {
    out[key] = { state: entry.state, mergeable: entry.mergeable };
  }
  return out;
}

/** Test-only: clear the store between cases. */
export function __resetPrStatesForTest(): void {
  store.clear();
}
