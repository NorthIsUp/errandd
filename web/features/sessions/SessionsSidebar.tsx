import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "../../api/sessions";
import { listSessions } from "../../api/sessions";
import { Button } from "../../components/Button";
import { Spinner } from "../../components/Spinner";
import {
  getThreadKeyForSession,
  groupSessionsIntoThreads,
} from "./groupSessionsIntoThreads";
import styles from "./SessionsSidebar.module.css";
import { ThreadGroup } from "./ThreadGroup";

interface Props {
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onOpenJob: (jobName: string) => void;
}

export function SessionsSidebar({ activeId, onSelect, onOpenJob }: Props) {
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [loading, setLoading] = useState(true);
  // Track which thread keys have been auto-expanded (plain object, not a ref, to avoid read-in-render lint)
  const [autoExpanded] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const sessions = await listSessions(true); // always fetch all
      setAllSessions(Array.isArray(sessions) ? sessions : []);
    } catch {
      // keep previous
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(); // async — setState called in promise resolution, not synchronously
  }, [load]);

  const closedCount = allSessions.filter((s) => s.closed).length;
  const visibleSessions = showClosed
    ? allSessions
    : allSessions.filter((s) => !s.closed);

  const threads = groupSessionsIntoThreads(visibleSessions);

  // Determine which thread should be auto-expanded for the active session
  let activeThreadKey: string | null = null;
  if (activeId) {
    const active = allSessions.find((s) => s.id === activeId);
    if (active) activeThreadKey = getThreadKeyForSession(active);
  }

  return (
    <div className={styles.sidebar}>
      {/* Top bar: + New + Show Closed toggle */}
      <div className={styles.sidebarTop}>
        <Button
          variant="primary"
          size="sm"
          className={styles.newBtn}
          onClick={() => {
            onSelect(null);
          }}
        >
          + New
        </Button>
        <label
          className={styles.closedToggle}
          title={`Show closed (${closedCount})`}
        >
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => {
              setShowClosed(e.target.checked);
            }}
          />
          Closed ({closedCount})
        </label>
      </div>

      {/* Session list */}
      <div className={styles.list}>
        {loading ? (
          <div className={styles.loading}>
            <Spinner size="sm" />
          </div>
        ) : threads.length === 0 ? (
          <div className={styles.empty}>No sessions yet</div>
        ) : (
          threads.map((thread) => {
            const isActiveThread = thread.key === activeThreadKey;
            // Auto-expand the first time we see the active thread
            let defaultExpanded = isActiveThread;
            if (isActiveThread && !autoExpanded.has(thread.key)) {
              autoExpanded.add(thread.key);
              defaultExpanded = true;
            }
            return (
              <ThreadGroup
                key={thread.key}
                thread={thread}
                activeId={activeId}
                defaultExpanded={defaultExpanded}
                onSelect={(id) => {
                  onSelect(id);
                }}
                onRefresh={() => {
                  void load();
                }}
                onOpenJob={onOpenJob}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
