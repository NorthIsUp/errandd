import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
} from "@pikoloo/darwin-ui";
import { useState } from "react";
import type { SessionInfo } from "../../api/sessions";
import { formatSessionTime } from "../chat/formatClockTime";
import type { SessionThread, ThreadKind } from "./groupSessionsIntoThreads";
import { SessionRow } from "./SessionRow";
import styles from "./ThreadGroup.module.css";

// All thread-kind pills share the same outlined "good" visual the user prefers.
const KIND_VARIANT: Record<
  ThreadKind,
  "success" | "info" | "warning" | "secondary"
> = {
  job: "success",
  agent: "success",
  web: "success",
  discord: "success",
};

const THREAD_PAGE = 10;

interface Props {
  thread: SessionThread;
  activeId: string | null;
  defaultExpanded?: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  /**
   * Called when the user clicks the 🗂 job-file link.
   * Mechanism: navigate to #jobs?file=<jobName>.md via hash + query param
   * so JobsSection can open the file directly. Documented in ChatsSection.tsx.
   */
  onOpenJob?: (jobName: string) => void;
}

export function ThreadGroup({
  thread,
  activeId,
  defaultExpanded = false,
  onSelect,
  onRefresh,
  onOpenJob,
}: Props) {
  const [pageIdx, setPageIdx] = useState(0);

  const { sessions } = thread;
  const pageCount = Math.max(1, Math.ceil(sessions.length / THREAD_PAGE));
  const safePageIdx = Math.min(pageIdx, pageCount - 1);

  const pageSessions: SessionInfo[] =
    sessions.length > THREAD_PAGE
      ? sessions.slice(
          safePageIdx * THREAD_PAGE,
          (safePageIdx + 1) * THREAD_PAGE,
        )
      : sessions;

  const newest = sessions[0];
  const newestPreview =
    thread.kind === "job"
      ? (newest?.title ?? "")
      : (newest?.title ?? newest?.lastMessage ?? newest?.firstMessage ?? "");
  const newestTime = newest?.lastUsedAt
    ? formatSessionTime(newest.lastUsedAt)
    : "";
  const countText = sessions.length > 1 ? ` · ${sessions.length}` : "";

  return (
    <Accordion
      type="single"
      {...(defaultExpanded ? { defaultValue: thread.key } : {})}
      className={styles.thread ?? ""}
    >
      <AccordionItem value={thread.key}>
        <AccordionTrigger className={styles.trigger ?? ""}>
          <div className={styles.triggerContent ?? ""}>
            <span className={styles.label} title={thread.label}>
              {thread.label}
            </span>

            <Badge variant={KIND_VARIANT[thread.kind]}>{thread.kind}</Badge>

            {thread.kind === "job" && onOpenJob && (
              <button
                type="button"
                className={styles.jobLink}
                title="Open job file"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenJob(thread.label);
                }}
              >
                🗂
              </button>
            )}

            <div className={styles.summary}>
              <div className={styles.summaryRow}>
                {newestPreview && (
                  <span className={styles.summaryPreview}>{newestPreview}</span>
                )}
                <span className={styles.summaryMeta}>
                  {newestTime}
                  {countText}
                </span>
              </div>
            </div>
          </div>
        </AccordionTrigger>

        <AccordionContent className={styles.body ?? ""}>
          {pageSessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              activeId={activeId}
              isJobSession={thread.kind === "job"}
              onSelect={onSelect}
              onRefresh={onRefresh}
            />
          ))}

          {sessions.length > THREAD_PAGE && (
            <div className={styles.paginator}>
              <button
                type="button"
                className={styles.pageBtn}
                disabled={safePageIdx === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  setPageIdx((p) => Math.max(0, p - 1));
                }}
              >
                ‹ prev
              </button>
              <span className={styles.pageInfo}>
                {safePageIdx + 1} / {pageCount}
              </span>
              <button
                type="button"
                className={styles.pageBtn}
                disabled={safePageIdx >= pageCount - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  setPageIdx((p) => Math.min(pageCount - 1, p + 1));
                }}
              >
                next ›
              </button>
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
