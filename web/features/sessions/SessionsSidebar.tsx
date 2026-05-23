import { Button, CircularProgress, Switch } from "@pikoloo/darwin-ui";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "../../api/sessions";
import { listSessions } from "../../api/sessions";
import { useFragmentState } from "../../hooks/useHash";
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
  // Persist the closed-sessions toggle in the hash: #chats?closed=1
  const [showClosedRaw, setShowClosedFragment] = useFragmentState("closed", "");
  const showClosed = showClosedRaw === "1";
  const setShowClosed = useCallback(
    (val: boolean) => setShowClosedFragment(val ? "1" : ""),
    [setShowClosedFragment],
  );
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
          className={styles.newBtn ?? ""}
          onClick={() => {
            onSelect(null);
          }}
        >
          <Plus className="h-3 w-3" />
          New
        </Button>
        <Switch
          label={`Closed (${closedCount})`}
          checked={showClosed}
          onChange={setShowClosed}
          className={styles.closedToggle}
          title={`Show closed (${closedCount})`}
        />
      </div>

      {/* Session list */}
      <div className={styles.list}>
        {loading ? (
          <div className={styles.loading}>
            <CircularProgress indeterminate size={14} strokeWidth={2} />
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
