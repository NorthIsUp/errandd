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
}

export interface TreeItem {
  /** Stable subject key (`repo#num` / sentry id / monitor / jobName). */
  key: string;
  /** Human title shown in the tree row. */
  title: string;
  routines: ThreadRef[];
  /** Latest activity across all routines (for sort). */
  lastAt: number;
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

/** Subject key + title for the item a row belongs to. */
function itemFor(source: TreeSource, m: QueueMessage): { key: string; title: string } {
  if (source === "github") {
    const repo = m.prRepo ?? "?";
    const num = m.prNumber == null ? "" : `#${m.prNumber}`;
    const key = `${repo}${num}`;
    const detail = m.keys?.key2 || m.keys?.key1 || "";
    return { key, title: detail ? `${key} · ${detail}` : key };
  }
  if (source === "sentry" || source === "datadog" || source === "linear") {
    // Tickets/issues/monitors are keyed by their provider id (e.g. ENG-204).
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

    const { key, title } = itemFor(source, m);
    let item = items.get(key);
    if (!item) {
      item = { key, title, routines: [], lastAt: 0 };
      items.set(key, item);
    } else if (title.length > item.title.length) {
      // Prefer the richest title we've seen (a later row may carry keys).
      item.title = title;
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
