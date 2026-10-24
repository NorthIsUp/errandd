import { useMemo } from "react";
import { useSharedQueue } from "./useSharedQueue";
import type { QueueMessage } from "../../api/hooks";

/**
 * The cross-referenced sources for a thread — shown as links above the chat
 * (the PR it's on, the Linear ticket it references, etc.). Derived client-side
 * from the durable queue rows for this thread (their extracted `fields` carry
 * repo / PR / linear). Backend-derived Sentry/Datadog deep links can be folded
 * in later via the messages endpoint.
 */
export interface ThreadSource {
  kind: "github" | "linear" | "sentry" | "datadog";
  href: string;
  label: string;
}

function fieldOf(m: QueueMessage, label: string): string | undefined {
  return m.fields?.find((f) => f.label === label)?.value || undefined;
}

function deriveSources(rows: QueueMessage[]): ThreadSource[] {
  const out: ThreadSource[] = [];
  const seen = new Set<string>();
  const add = (s: ThreadSource) => {
    if (seen.has(s.href)) {
      return;
    }
    seen.add(s.href);
    out.push(s);
  };
  for (const m of rows) {
    // The PR this thread is on.
    if (m.prRepo && m.prNumber != null) {
      add({
        kind: "github",
        href: `https://github.com/${m.prRepo}/pull/${m.prNumber}`,
        label: `${m.prRepo.split("/").pop()}#${m.prNumber}`,
      });
    }
    // A Linear ticket the PR references (extracted from the branch/title).
    const linear = fieldOf(m, "linear");
    if (linear) {
      add({ kind: "linear", href: `https://linear.app/issue/${linear}`, label: linear });
    }
  }
  return out;
}

export function useThreadSources(threadId: string | null): ThreadSource[] {
  const { messages } = useSharedQueue();
  return useMemo(
    () => threadId ? deriveSources(messages.filter(message => message.threadId === threadId)) : [],
    [messages, threadId],
  );
}
