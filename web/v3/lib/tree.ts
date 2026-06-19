import type { QueueMessage, QueueOutcomeResult, QueueStatus } from "../../api/hooks";

/**
 * The sidebar hook tree (spec §4), built entirely client-side from the durable
 * queue snapshot (`GET /api/hooks/queue` + its `/events` SSE).
 *
 *   SidebarTree = Section[]
 *     Section { source, label, items: Item[] }
 *       Item  { key, title, routines: ThreadRef[] }   // one per hook subject
 *         ThreadRef { threadId, jobName, status, outcome, lastAt }
 *
 * A section groups by hook *source* (github / sentry / datadog / routines); an
 * item is one subject within that source (a PR, a Sentry issue, a Datadog
 * monitor, or — for plain cron runs — the routine itself); each `(item ×
 * jobName)` is one chat thread.
 */

export type TreeSource = "github" | "sentry" | "datadog" | "linear" | "routines";

export interface ThreadRef {
  /** `<jobName>:hook:<scope>` — the resumed Claude session id. */
  threadId: string;
  jobName: string;
  status: QueueStatus;
  outcome: QueueOutcomeResult | null;
  /** Latest activity (max of enqueuedAt/updatedAt across the thread's rows). */
  lastAt: number;
  /** Conversation turn count (runs/resumes on this thread), when known. Joined
   *  from the sessions store by threadId; absent until a session exists. */
  turnCount?: number;
  /** Total tokens (input + output + cache) spent on this thread's session(s),
   *  when known. Joined from /api/usage by threadId; absent until usage exists. */
  tokens?: number;
}

export interface TreeItem {
  /** Stable subject key (`repo#num` / sentry id / monitor / jobName). */
  key: string;
  /** Human title shown in the tree row. */
  title: string;
  routines: ThreadRef[];
  /** Latest activity across all routines (for sort). */
  lastAt: number;
  /** GitHub items: the org/repo this PR belongs to (sidebar groups by it). */
  repo?: string;
  /** GitHub items: PR number (for `#num` display + sort-by-number). */
  num?: number;
  /** GitHub items: PR title — the "name" shown after `#num`. */
  name?: string;
  /** True only for synthetic items injected by the PR reconciliation poller
   *  (not present in the durable queue). Drives the "no routine activity" hint. */
  polledOnly?: true;
}

export interface TreeSection {
  source: TreeSource;
  label: string;
  items: TreeItem[];
}

export type SidebarTree = TreeSection[];

/** Section order + display labels (spec §1: Schedules / Errors / Alerts / PRs). */
export const SECTION_ORDER: { source: TreeSource; label: string }[] = [
  { source: "routines", label: "Schedules" },
  { source: "sentry", label: "Errors" },
  { source: "datadog", label: "Alerts" },
  { source: "linear", label: "Tickets" },
  { source: "github", label: "Pull Requests" },
];

/** Map a queue row's `event` to its hook source. */
export function sourceForEvent(m: QueueMessage): TreeSource {
  const ev = m.event;
  if (ev.startsWith("sentry")) {
    return "sentry";
  }
  if (ev.startsWith("datadog")) {
    return "datadog";
  }
  if (ev.startsWith("linear")) {
    return "linear";
  }
  // GitHub webhook events: pull_request*, issue*, issue_comment, push, …, and
  // any PR-tagged row (prNumber set) regardless of event name.
  if (
    m.prNumber != null ||
    ev.startsWith("pull_request") ||
    ev.startsWith("issue") ||
    ev.startsWith("push") ||
    ev.startsWith("github")
  ) {
    return "github";
  }
  // web:message (interactive composer) and plain cron runs → routines, unless
  // the thread is otherwise PR-scoped (handled above).
  return "routines";
}

/** Read an extracted field value by label (e.g. the PR "title"). */
function fieldValue(m: QueueMessage, label: string): string | undefined {
  return m.fields?.find((f) => f.label === label)?.value || undefined;
}

/**
 * Human-ish fallback label for a sentry/datadog item when no extracted field
 * is present — strips the known scope prefix so `sentry-issue-42` renders as
 * `issue 42` and `dd-monitor-7` as `monitor 7`. Returns undefined for scopes
 * that don't carry the prefix (e.g. `delivery-…` or a datadog aggregation key).
 */
function scopeLabel(scope: string | undefined, prefix: string): string | undefined {
  if (!scope || !scope.startsWith(prefix)) {
    return undefined;
  }
  const id = scope.slice(prefix.length);
  if (!id) {
    return undefined;
  }
  const noun = prefix.includes("issue") ? "issue" : "monitor";
  return `${noun} ${id}`;
}

interface ItemInfo {
  key: string;
  title: string;
  repo?: string;
  num?: number;
  name?: string;
}

/** Subject key + title for the item a row belongs to. */
function itemFor(source: TreeSource, m: QueueMessage): ItemInfo {
  if (source === "github") {
    const repo = m.prRepo ?? "?";
    const num = m.prNumber ?? null;
    const key = `${repo}#${num ?? ""}`;
    // The important info per the sidebar IA is `#num — name`; the org/repo is a
    // collapsible group header, not repeated on every row.
    const name = fieldValue(m, "title") || "";
    const title = num == null ? repo : `#${num}${name ? ` — ${name}` : ""}`;
    const info: ItemInfo = { key, title, repo };
    if (num != null) {
      info.num = num;
    }
    if (name) {
      info.name = name;
    }
    return info;
  }
  if (source === "sentry") {
    // The subject is the Sentry *issue*, not its level. The issue identity is
    // the coalescing scope (`sentry-issue-<id>`); key on that so distinct
    // issues stay distinct — keying on `keys.key1` (the level) would collapse
    // every `error`-level issue into one row. Title prefers the human issue
    // title (extracted into `fields` as `issue`), then the project slug, then
    // a label derived from the scope.
    const key = m.scope || m.keys?.key1 || m.jobName;
    // Prefer the human ticket id (CLARA-BACKEND-T1, extracted as `shortId`) for
    // the row name — cleaner than the long error title. Falls back to the issue
    // title → project → scope-derived label chain (error events carry no shortId).
    const title =
      fieldValue(m, "shortId") ||
      fieldValue(m, "issue") ||
      fieldValue(m, "project") ||
      scopeLabel(m.scope, "sentry-issue-") ||
      key;
    return { key, title };
  }
  if (source === "datadog") {
    // The subject is the Datadog *monitor* (scope `dd-monitor-<id>` / `dd-<agg>`),
    // not its priority. Key on the scope so re-alerts on one monitor coalesce
    // instead of every alert of a given priority collapsing together. Title
    // prefers the alert `title` field, then the monitor id, then the scope.
    const key = m.scope || m.keys?.key1 || m.jobName;
    const title =
      fieldValue(m, "title") || fieldValue(m, "monitor") || scopeLabel(m.scope, "dd-monitor-") || key;
    return { key, title };
  }
  if (source === "linear") {
    // Tickets are keyed by their provider id (e.g. ENG-204).
    const key = m.keys?.key1 || m.scope || m.jobName;
    const detail = m.keys?.key2 || "";
    return { key, title: detail ? `${key} · ${detail}` : key };
  }
  // routines: the routine itself is the subject.
  return { key: m.jobName, title: m.jobName };
}

/** Latest activity timestamp for a row. */
function rowAt(m: QueueMessage): number {
  return Math.max(m.enqueuedAt, m.updatedAt);
}

/**
 * Build the full sidebar tree from a queue snapshot. Pure — safe to memoize on
 * the message array. Sections always appear in `SECTION_ORDER`; empty sections
 * are kept (rendered collapsed/empty) so the shell is stable as hooks arrive.
 */
export function buildTree(messages: QueueMessage[]): SidebarTree {
  // source → item key → { item, jobName → ThreadRef }
  const sections = new Map<TreeSource, Map<string, TreeItem>>();
  for (const { source } of SECTION_ORDER) {
    sections.set(source, new Map());
  }

  for (const m of messages) {
    const source = sourceForEvent(m);
    const items = sections.get(source);
    if (!items) {
      continue;
    }

    const info = itemFor(source, m);
    let item = items.get(info.key);
    if (item) {
      // A later row may carry the richer PR title — adopt it.
      if (info.name && info.name.length > (item.name?.length ?? 0)) {
        item.name = info.name;
        item.title = info.title;
      } else if (info.title.length > item.title.length) {
        item.title = info.title;
      }
    } else {
      item = {
        key: info.key,
        title: info.title,
        routines: [],
        lastAt: 0,
        ...(info.repo ? { repo: info.repo } : {}),
        ...(info.num == null ? {} : { num: info.num }),
        ...(info.name ? { name: info.name } : {}),
      };
      items.set(info.key, item);
    }

    const at = rowAt(m);
    let ref = item.routines.find((r) => r.jobName === m.jobName);
    if (!ref) {
      ref = {
        threadId: m.threadId || `${m.jobName}:hook:${m.scope}`,
        jobName: m.jobName,
        status: m.status,
        outcome: m.outcome ?? null,
        lastAt: at,
      };
      item.routines.push(ref);
    } else if (at >= ref.lastAt) {
      // Newest row wins for the live status/outcome shown on the ThreadRef.
      ref.status = m.status;
      ref.outcome = m.outcome ?? null;
      ref.lastAt = at;
      if (m.threadId) {
        ref.threadId = m.threadId;
      }
    }
    item.lastAt = Math.max(item.lastAt, at);
  }

  return SECTION_ORDER.map(({ source, label }) => {
    const items = [...(sections.get(source)?.values() ?? [])];
    for (const it of items) {
      it.routines.sort((a, b) => a.jobName.localeCompare(b.jobName));
    }
    items.sort((a, b) => b.lastAt - a.lastAt);
    return { source, label, items };
  });
}

// ---------------------------------------------------------------------------
// PR reconciliation merge
// ---------------------------------------------------------------------------

/** Shape returned by GET /api/prs/open (the daemon's reconciliation poller). */
export interface PolledPR {
  repo: string;
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  updatedAt: string; // ISO string
  labels: string[];
}

/**
 * Merges polled open PRs into an existing github-section item list.
 *
 * - PRs already in the queue (same `repo#number` key) are left completely
 *   untouched — queue items keep all their routine threads and live status.
 * - New polled-only PRs get a synthetic TreeItem with no routines and
 *   `polledOnly: true` (drives the "no routine activity" hint in the sidebar).
 * - `lastAt` for polled-only PRs is set to `Date.parse(updatedAt)` so the
 *   existing days-window filter and sort-by-recency work automatically.
 *
 * Pure and safe to call inside `useMemo`.
 */
export function mergePolledPRs(queueItems: TreeItem[], polled: PolledPR[]): TreeItem[] {
  if (polled.length === 0) {
    return queueItems;
  }
  const existing = new Set(queueItems.map((i) => i.key));
  const synthetic: TreeItem[] = polled
    .filter((pr) => !existing.has(`${pr.repo}#${pr.number}`))
    .map((pr): TreeItem => ({
      key: `${pr.repo}#${pr.number}`,
      title: `#${pr.number}${pr.title ? ` — ${pr.title}` : ""}`,
      routines: [],
      lastAt: Date.parse(pr.updatedAt) || 0,
      repo: pr.repo,
      num: pr.number,
      ...(pr.title ? { name: pr.title } : {}),
      polledOnly: true,
    }));
  return synthetic.length === 0 ? queueItems : [...queueItems, ...synthetic];
}
