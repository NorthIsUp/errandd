import { useState } from "react";
import type { SessionInfo } from "../../api/sessions";
import { Pill } from "../../components/Pill";
import { formatSessionTime } from "../chat/formatClockTime";
import type { SessionThread, ThreadKind } from "./groupSessionsIntoThreads";
import { SessionRow } from "./SessionRow";
import styles from "./ThreadGroup.module.css";

const KIND_TONE: Record<ThreadKind, "warn" | "accent" | "good" | "muted"> = {
  job: "warn",
  agent: "good",
  web: "accent",
  discord: "muted",
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
  const [expanded, setExpanded] = useState(defaultExpanded);
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

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded((v) => !v);
    if (expanded) setPageIdx(0);
  }

  function headerClick() {
    // Clicking header body (not caret) → browse the most-recent session
    if (sessions[0]) onSelect(sessions[0].id);
  }

  return (
    <div
      className={[styles.thread, expanded ? styles.expanded : undefined]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Thread header — div because it contains buttons (nesting button in button is invalid) */}
      {/* biome-ignore lint/a11y/useSemanticElements: contains child buttons; nesting <button> in <button> is invalid HTML */}
      <div
        className={styles.header}
        onClick={headerClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") headerClick();
        }}
      >
        <button
          type="button"
          className={styles.caret}
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          ▶
        </button>

        <span className={styles.label} title={thread.label}>
          {thread.label}
        </span>

        <Pill tone={KIND_TONE[thread.kind]} size="sm">
          {thread.kind}
        </Pill>

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

      {/* Thread body — shown only when expanded */}
      <div className={styles.body}>
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
      </div>
    </div>
  );
}
