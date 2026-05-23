import { useRef, useState } from "react";
import type { SessionInfo } from "../../api/sessions";
import { setSessionClosed, setSessionTitle } from "../../api/sessions";
import { Pill } from "../../components/Pill";
import { formatSessionTime } from "../chat/formatClockTime";
import styles from "./SessionRow.module.css";

interface Props {
  session: SessionInfo;
  activeId: string | null;
  isJobSession?: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

export function SessionRow({
  session: s,
  activeId,
  isJobSession = false,
  onSelect,
  onRefresh,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const isActive = s.id === activeId;
  const channel = s.channel !== "web" && s.channel !== "job" ? s.channel : "";
  const displayName = s.title ?? s.agent ?? "global";
  const previewText = isJobSession
    ? (s.title ?? "")
    : (s.title ?? s.lastMessage ?? s.firstMessage ?? "");

  function startRename(e: React.MouseEvent) {
    e.stopPropagation();
    setTitleValue(displayName);
    setRenaming(true);
    // focus in next tick after render
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }

  async function saveRename() {
    const newTitle = titleValue.trim();
    try {
      await setSessionTitle(s.id, newTitle);
    } catch {
      // ignore
    }
    setRenaming(false);
    onRefresh();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveRename();
    }
    if (e.key === "Escape") {
      setRenaming(false);
      onRefresh();
    }
  }

  async function toggleClose(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await setSessionClosed(s.id, !s.closed);
    } catch {
      // ignore
    }
    onRefresh();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: row contains interactive buttons — wrapping in <button> would nest buttons (invalid HTML)
    <div
      className={[
        styles.row,
        isActive ? styles.active : undefined,
        s.closed ? styles.closed : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => {
        onSelect(s.id);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(s.id);
      }}
    >
      {/* Header row — only for non-job sessions */}
      {!isJobSession && (
        <div className={styles.headerRow}>
          {renaming ? (
            <input
              ref={inputRef}
              className={styles.titleInput}
              value={titleValue}
              onChange={(e) => {
                setTitleValue(e.target.value);
              }}
              onBlur={() => {
                void saveRename();
              }}
              onKeyDown={onKeyDown}
              onClick={(e) => {
                e.stopPropagation();
              }}
            />
          ) : (
            <span className={styles.agentName}>{displayName}</span>
          )}
          {channel && (
            <Pill tone="muted" size="sm">
              {channel}
            </Pill>
          )}
        </div>
      )}

      {/* Preview */}
      {previewText && <div className={styles.preview}>{previewText}</div>}

      {/* Time + actions row */}
      <div className={styles.timeRow}>
        <span className={styles.time}>
          {formatSessionTime(s.lastUsedAt)} · {s.turnCount ?? 0} turns
        </span>
        <div className={styles.actions}>
          {!isJobSession && (
            <button
              type="button"
              className={styles.renameBtn}
              title="Rename"
              onClick={startRename}
            >
              ✎
            </button>
          )}
          <button
            type="button"
            className={styles.closeBtn}
            title={s.closed ? "Reopen" : "Close"}
            onClick={toggleClose}
          >
            {s.closed ? "↺" : "×"}
          </button>
        </div>
      </div>
    </div>
  );
}
