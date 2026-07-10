/**
 * Live PR lifecycle context for GitHub-triggered routines.
 *
 * The webhook payload prepended to a routine's prompt is a POINT-IN-TIME
 * snapshot: a `pull_request_review` "approved" event carries no CI status, an
 * `issue_comment` carries no merge state, and by the time a queued delivery
 * actually runs the PR may have moved on. That gap is how a babysit/review run
 * ends up saying "fix looks solid, safe to merge" while Quality Gate is red.
 *
 * To close it we fetch the AUTHORITATIVE current state with `gh pr view` at run
 * time and inject it as an `--append-system-prompt` block on every
 * GitHub-triggered (and resumed) run — so the model always sees fresh
 * merge/review/CI state and is told to trust it over the stale payload.
 */

/** One normalized entry from `statusCheckRollup` (CheckRun or StatusContext). */
export interface LifecycleCheck {
  name: string;
  /** CheckRun status: QUEUED | IN_PROGRESS | COMPLETED (absent for StatusContext). */
  status?: string;
  /** CheckRun conclusion (SUCCESS | FAILURE | …) or StatusContext state. */
  conclusion?: string;
}

export interface PrLifecycleData {
  repo: string;
  number: number;
  title?: string;
  /** OPEN | CLOSED | MERGED. */
  state?: string;
  isDraft?: boolean;
  /** MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable?: string;
  /** CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | HAS_HOOKS | UNKNOWN. */
  mergeStateStatus?: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "" (none required). */
  reviewDecision?: string;
  baseRefName?: string;
  headRefName?: string;
  checks: LifecycleCheck[];
}

/** Fields requested from `gh pr view`. Kept in one place so the fetch and the
 *  type stay in sync. */
const GH_PR_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "baseRefName",
  "headRefName",
  "statusCheckRollup",
] as const;

const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "ERROR",
]);
const PENDING_STATUSES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

type CheckVerdict = "failing" | "pending" | "passing" | "unknown";

/** Classify a normalized check into failing / pending / passing / unknown.
 *  A check is PENDING when it hasn't completed (status QUEUED/IN_PROGRESS or a
 *  PENDING StatusContext state); only completed checks count as pass/fail. */
export function classifyCheck(c: LifecycleCheck): CheckVerdict {
  const conclusion = (c.conclusion ?? "").toUpperCase();
  const status = (c.status ?? "").toUpperCase();
  // A StatusContext carries no `status`; its `conclusion` holds the state
  // (PENDING/SUCCESS/FAILURE/ERROR). A CheckRun that isn't COMPLETED is pending
  // regardless of a (usually empty) conclusion.
  if (status && status !== "COMPLETED") {
    return PENDING_STATUSES.has(status) ? "pending" : "unknown";
  }
  if (conclusion === "PENDING") return "pending";
  if (FAILING_CONCLUSIONS.has(conclusion)) return "failing";
  if (PASSING_CONCLUSIONS.has(conclusion)) return "passing";
  if (!conclusion) return "pending"; // completed-but-no-conclusion ≈ still settling
  return "unknown";
}

const VERDICT_ICON: Record<CheckVerdict, string> = {
  failing: "❌",
  pending: "⏳",
  passing: "✅",
  unknown: "❔",
};

/** Max individual (failing/pending) checks to spell out before truncating, so a
 *  PR with a huge matrix can't blow the system-prompt budget. Passing checks are
 *  only ever summarized as a count. */
const MAX_LISTED_CHECKS = 30;

/**
 * Render the authoritative lifecycle block. Pure (no I/O) so it's unit-testable;
 * `buildPrLifecyclePrompt` wraps it around the `gh` fetch.
 */
export function formatPrLifecycle(d: PrLifecycleData): string {
  const lines: string[] = [];
  lines.push("## PR lifecycle — live state (fetched at run time)");
  lines.push(
    "This is the AUTHORITATIVE current state of the PR, fetched live via `gh` just before this run. " +
      "Trust it over any webhook payload above, which is a point-in-time snapshot and may be stale. " +
      "Do NOT claim CI is green, the PR is approved, or it is safe to merge unless THIS block says so.",
  );

  const title = d.title ? ` — "${d.title}"` : "";
  lines.push(`- **PR:** ${d.repo}#${d.number}${title}`);

  const state = (d.state ?? "UNKNOWN").toUpperCase();
  const draft = d.isDraft ? " · draft" : "";
  let stateNote = "";
  if (state === "MERGED") stateNote = " — already merged; no further work needed";
  else if (state === "CLOSED") stateNote = " — closed (not merged); do not push work unless reopened";
  lines.push(`- **State:** ${state}${draft}${stateNote}`);

  if (d.reviewDecision) {
    lines.push(`- **Review decision:** ${d.reviewDecision}`);
  } else {
    lines.push("- **Review decision:** none (no review required / not yet reviewed)");
  }

  const mergeBits = [d.mergeable, d.mergeStateStatus ? `merge state: ${d.mergeStateStatus}` : null]
    .filter(Boolean)
    .join(" · ");
  if (mergeBits) lines.push(`- **Mergeable:** ${mergeBits}`);

  if (d.baseRefName || d.headRefName) {
    lines.push(`- **Branch:** ${d.baseRefName ?? "?"} ← ${d.headRefName ?? "?"}`);
  }

  // CI rollup: summary counts + spell out the actionable (failing/pending) ones.
  const checks = d.checks ?? [];
  if (checks.length === 0) {
    lines.push("- **CI:** no checks reported");
  } else {
    const verdicts = checks.map((c) => ({ c, v: classifyCheck(c) }));
    const failing = verdicts.filter((x) => x.v === "failing");
    const pending = verdicts.filter((x) => x.v === "pending");
    const passing = verdicts.filter((x) => x.v === "passing");
    const unknown = verdicts.filter((x) => x.v === "unknown");
    const summary = [
      failing.length ? `❌ ${failing.length} failing` : null,
      pending.length ? `⏳ ${pending.length} pending` : null,
      passing.length ? `✅ ${passing.length} passing` : null,
      unknown.length ? `❔ ${unknown.length} unknown` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`- **CI:** ${summary}`);
    // Detail the actionable checks (failing first, then pending, then unknown).
    const actionable = [...failing, ...pending, ...unknown];
    for (const { c, v } of actionable.slice(0, MAX_LISTED_CHECKS)) {
      const result = (c.conclusion || c.status || "?").toUpperCase();
      lines.push(`    - ${VERDICT_ICON[v]} ${c.name} — ${result}`);
    }
    if (actionable.length > MAX_LISTED_CHECKS) {
      lines.push(`    - …and ${actionable.length - MAX_LISTED_CHECKS} more`);
    }
  }

  return lines.join("\n");
}

/** Normalize a raw `statusCheckRollup` entry (CheckRun | StatusContext) into a
 *  LifecycleCheck. CheckRun has `name`/`status`/`conclusion`; a legacy
 *  StatusContext has `context`/`state`. */
function normalizeCheck(raw: unknown): LifecycleCheck | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const name = (typeof o.name === "string" && o.name) || (typeof o.context === "string" && o.context);
  if (!name) return null;
  const status = typeof o.status === "string" ? o.status : undefined;
  const conclusion =
    typeof o.conclusion === "string" && o.conclusion
      ? o.conclusion
      : typeof o.state === "string"
        ? o.state
        : undefined;
  return { name, ...(status ? { status } : {}), ...(conclusion ? { conclusion } : {}) };
}

/** Parse the JSON `gh pr view` emits into PrLifecycleData. Exported for tests. */
export function parsePrLifecycle(repo: string, json: unknown): PrLifecycleData | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  const number = typeof o.number === "number" ? o.number : Number(o.number);
  if (!Number.isFinite(number)) return null;
  const rollup = Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : [];
  const checks = rollup.map(normalizeCheck).filter((c): c is LifecycleCheck => c !== null);
  return {
    repo,
    number,
    title: typeof o.title === "string" ? o.title : undefined,
    state: typeof o.state === "string" ? o.state : undefined,
    isDraft: o.isDraft === true,
    mergeable: typeof o.mergeable === "string" ? o.mergeable : undefined,
    mergeStateStatus: typeof o.mergeStateStatus === "string" ? o.mergeStateStatus : undefined,
    reviewDecision: typeof o.reviewDecision === "string" ? o.reviewDecision : undefined,
    baseRefName: typeof o.baseRefName === "string" ? o.baseRefName : undefined,
    headRefName: typeof o.headRefName === "string" ? o.headRefName : undefined,
    checks,
  };
}

/** Fetch live PR state via `gh pr view`. Returns null (never throws) on any
 *  failure — a missing/renamed PR, gh auth trouble, or a network blip must not
 *  break the run; it just means no lifecycle block this turn. */
export async function fetchPrLifecycle(
  repo: string,
  prNumber: number,
  timeoutMs = 15_000,
): Promise<PrLifecycleData | null> {
  try {
    const proc = Bun.spawn(
      [
        "gh",
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        GH_PR_FIELDS.join(","),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      console.error(
        `[prLifecycle] gh pr view ${repo}#${prNumber} exited ${exitCode}: ${err.trim().slice(0, 200)}`,
      );
      return null;
    }
    return parsePrLifecycle(repo, JSON.parse(out));
  } catch (e) {
    console.error(`[prLifecycle] failed to fetch ${repo}#${prNumber}:`, e);
    return null;
  }
}

/** Fetch + format the lifecycle block for a PR. Returns null when the fetch
 *  fails so callers can simply skip injecting the block. */
export async function buildPrLifecyclePrompt(
  repo: string,
  prNumber: number,
): Promise<string | null> {
  const data = await fetchPrLifecycle(repo, prNumber);
  return data ? formatPrLifecycle(data) : null;
}
