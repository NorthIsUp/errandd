import { cveRemediationChat } from "./cveRemediationChat";
import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import type { QueueMessage, QueueStatus } from "../../api/hooks";
import type { SessionInfo } from "../../api/sessions";
import type { SidebarTree, TreeSource } from "./tree";

export interface ThreadEntry {
  threadId: string;
  title: string;
  subtitle: string;
  source: TreeSource;
  jobName: string;
  status: QueueStatus | null;
  lastAt: number;
  search: string;
  finding?: CveFindingSummary;
}

const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Reuses the sidebar's data. No per-keystroke requests or transcript loading. */
export function buildThreadCatalog(tree: SidebarTree, messages: QueueMessage[], sessions: SessionInfo[]): ThreadEntry[] {
  const latest = new Map<string, QueueMessage>();
  for (const message of messages) {
    if ((latest.get(message.threadId)?.updatedAt ?? -1) < message.updatedAt) latest.set(message.threadId, message);
  }
  const entries = new Map<string, ThreadEntry>();
  for (const section of tree) for (const item of section.items) for (const ref of item.routines) {
    const chat = section.source === "cve" ? cveRemediationChat(item) : null;
    const subject = chat?.routines.some(value => value.threadId === ref.threadId) ? chat : item;
    const message = latest.get(ref.threadId);
    const fields = message?.fields?.filter(field => /^(author|actor|branch|title)$/i.test(field.label)).map(field => field.value).join(" ") ?? "";
    const subtitle = [subject.repo, ref.jobName, section.label].filter(Boolean).join(" · ");
    const entry: ThreadEntry = {
      threadId: ref.threadId, title: subject.title, subtitle, source: section.source,
      jobName: ref.jobName, status: ref.status, lastAt: ref.lastAt,
      search: normalize(`${subject.title} ${subtitle} ${ref.threadId} ${ref.jobName}.md ${fields} ${subject.finding ? [subject.finding.status, ...subject.finding.aliases, ...subject.finding.packageNames].join(" ") : ""}`),
      ...(subject.finding ? { finding: subject.finding } : {}),
    };
    if ((entries.get(ref.threadId)?.lastAt ?? -1) < ref.lastAt) entries.set(ref.threadId, entry);
  }
  for (const session of sessions) {
    if (session.closed) continue;
    const threadId = session.threadId || session.id;
    const existing = entries.get(threadId);
    const trigger = session.trigger?.kind === "hook" ? session.trigger : null;
    const metadata = `${session.title ?? ""} ${trigger?.actor ?? ""} ${trigger?.repo ?? ""} ${trigger?.pr ? `#${trigger.pr.number}` : ""}`;
    if (existing) {
      // Session triggers carry the original author even after bot updates.
      existing.search += normalize(` ${metadata}`);
      existing.lastAt = Math.max(existing.lastAt, Date.parse(session.lastUsedAt) || 0);
      continue;
    }
    const jobName = session.jobName ?? "";
    const title = session.title || jobName || "Conversation";
    const subtitle = [jobName, session.agent, session.channel].filter(Boolean).join(" · ");
    entries.set(threadId, {
      threadId, title, subtitle, jobName, source: "routines",
      status: session.result === "error" ? "failed" : session.result ? "done" : null,
      lastAt: Date.parse(session.lastUsedAt) || 0,
      search: normalize(`${title} ${subtitle} ${threadId} ${jobName}.md ${metadata}`),
    });
  }
  return [...entries.values()].sort((a, b) => b.lastAt - a.lastAt || a.threadId.localeCompare(b.threadId));
}

export function searchThreads(entries: ThreadEntry[], query: string): ThreadEntry[] {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  return tokens.length ? entries.filter(entry => tokens.every(token => entry.search.includes(token))) : entries;
}
