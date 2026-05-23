import { useCallback, useState } from "react";
import { SectionFrame } from "../../components/SectionFrame";
import { ChatPane } from "../../features/chat/ChatPane";
import { SessionsSidebar } from "../../features/sessions/SessionsSidebar";
import { useFragmentState } from "../../hooks/useHash";
import styles from "./ChatsSection.module.css";

/**
 * Cross-section job-file open mechanism:
 * When the user clicks the 🗂 button on a job thread header, we navigate to
 * `#jobs?file=<jobName>.md`. JobsSection (Phase 7) reads the `?file=` query
 * param via `window.location.search` on mount and when the hash changes, then
 * opens that file in the editor. This avoids global state and keeps the
 * communication through the URL — inspectable, bookmarkable, simple.
 *
 * Format: #jobs?file=<urlencoded-filename>[&repo=<urlencoded-slug>]
 */
function openJobFile(jobName: string) {
  const filename = `${jobName}.md`;
  window.location.hash = `jobs?file=${encodeURIComponent(filename)}`;
}

export function ChatsSection() {
  // Persist active session ID in the hash: #chats?id=<sessionId>
  const [activeIdRaw, setActiveIdFragment] = useFragmentState("id", "");
  const activeId = activeIdRaw || null;
  const setActiveId = useCallback(
    (id: string | null) => setActiveIdFragment(id ?? ""),
    [setActiveIdFragment],
  );

  const [showDetail, setShowDetail] = useState(!!activeId);

  const handleSelect = useCallback(
    (id: string | null) => {
      setActiveId(id);
      if (id !== null) {
        // On mobile, switch to the detail (chat pane) view
        setShowDetail(true);
      }
    },
    [setActiveId],
  );

  const handleBack = useCallback(() => {
    setShowDetail(false);
  }, []);

  return (
    <SectionFrame title="Chats" bodyClassName={styles.layout as string}>
      <div
        className={[styles.layout, showDetail ? styles.detail : undefined]
          .filter(Boolean)
          .join(" ")}
      >
        <div className={styles.sidebar}>
          <SessionsSidebar
            activeId={activeId}
            onSelect={handleSelect}
            onOpenJob={openJobFile}
          />
        </div>

        <div className={styles.chatPane}>
          <ChatPane
            activeId={activeId}
            onActiveIdChanged={setActiveId}
            onBack={handleBack}
          />
        </div>
      </div>
    </SectionFrame>
  );
}
