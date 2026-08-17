/**
 * Per-PR git state derived from GitHub `pull_request` webhook payloads.
 *
 * The daemon already receives `pull_request` events through the hook pipeline
 * (see app/hooks/github.ts `dispatchHook`); the payload carries the authoritative
 * `state` / `merged` / `mergeable` / `mergeable_state`. This module is the pure,
 * shared source of truth for turning those raw fields into the four states the
 * sidebar renders — imported by the daemon (app/pr-state.ts, which persists it)
 * and the web UI (the icon mapping).
 */

export type PrGitState = "open" | "draft" | "merged" | "closed" | "conflicted" | "unknown";

/** Terminal states never change again, so a resolved one can be cached forever. */
export function isTerminalPrState(state: PrGitState): boolean {
  return state === "merged" || state === "closed";
}

/** The subset of a `pull_request` webhook node we derive state from. */
export interface PrStatePayloadFields {
  /** "open" | "closed". */
  state?: unknown;
  /** true once a closed PR was merged (vs. closed unmerged). */
  merged?: unknown;
  /** true while the PR is a draft. */
  draft?: unknown;
  /** boolean | null — GitHub computes this async, so it's often null on the event. */
  mergeable?: unknown;
  /** "clean" | "dirty" | "blocked" | "behind" | "unstable" | "unknown" | … */
  mergeable_state?: unknown;
}

/** Per-PR state surfaced to the sidebar (via /api/prs/open). */
export interface PrStateInfo {
  state: PrGitState;
  /** Last known mergeability (null when GitHub hadn't computed it yet). */
  mergeable: boolean | null;
}

/**
 * Derive the sidebar git-state from a raw `pull_request` node.
 *
 * Precedence: a closed PR is merged-or-closed (never "conflicted"); an open PR
 * is "draft" first (GitHub shows the draft icon regardless of mergeability, and
 * a conflicted draft isn't actionable), then "conflicted" when GitHub reports a
 * dirty merge state or `mergeable: false`, else plain "open". Anything we can't
 * read (missing/odd payload) → "unknown", so the caller can keep a prior known
 * state rather than clobber it.
 *
 * Note: `mergeable`/`mergeable_state` are computed asynchronously by GitHub and
 * are frequently null/"unknown" on the webhook itself — conflict detection is
 * therefore best-effort and may lag until a later event carries the value.
 */
export function derivePrState(pr: PrStatePayloadFields | null | undefined): PrGitState {
  if (typeof pr !== "object" || pr === null) {
    return "unknown";
  }
  const state = typeof pr.state === "string" ? pr.state.toLowerCase() : "";
  const merged = pr.merged === true;
  const mergeableState =
    typeof pr.mergeable_state === "string" ? pr.mergeable_state.toLowerCase() : "";
  const mergeable = typeof pr.mergeable === "boolean" ? pr.mergeable : null;

  if (state === "closed") {
    return merged ? "merged" : "closed";
  }
  if (state === "open") {
    if (pr.draft === true) {
      return "draft";
    }
    if (mergeableState === "dirty" || mergeable === false) {
      return "conflicted";
    }
    return "open";
  }
  return "unknown";
}

/** The subset of a GraphQL `PullRequest` node the backfill query selects. */
export interface PrStateGraphqlFields {
  /** "OPEN" | "CLOSED" | "MERGED". */
  state?: unknown;
  isDraft?: unknown;
  /** "MERGEABLE" | "CONFLICTING" | "UNKNOWN". */
  mergeable?: unknown;
}

/**
 * Derive the sidebar git-state from a GraphQL `PullRequest` node.
 *
 * Same precedence as {@link derivePrState}; the difference is purely shape —
 * GraphQL reports MERGED as a first-class state (REST splits it into
 * `state: closed` + `merged: true`) and spells the fields in camelCase.
 */
export function derivePrStateFromGraphql(
  pr: PrStateGraphqlFields | null | undefined,
): PrGitState {
  if (typeof pr !== "object" || pr === null) {
    return "unknown";
  }
  const state = typeof pr.state === "string" ? pr.state.toUpperCase() : "";
  if (state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  if (state === "OPEN") {
    if (pr.isDraft === true) {
      return "draft";
    }
    return typeof pr.mergeable === "string" && pr.mergeable.toUpperCase() === "CONFLICTING"
      ? "conflicted"
      : "open";
  }
  return "unknown";
}
