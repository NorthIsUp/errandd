import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@pikoloo/darwin-ui";
import { ChevronDown, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "../../api/sessions";
import { listSessions } from "../../api/sessions";
import { SectionFrame } from "../../components/SectionFrame";
import { ChatPane } from "../../features/chat/ChatPane";
import { SessionsSidebar } from "../../features/sessions/SessionsSidebar";
import {
  getThreadKeyForSession,
  groupSessionsIntoThreads,
} from "../../features/sessions/groupSessionsIntoThreads";
import { useFragmentState } from "../../hooks/useHash";
import styles from "./ChatsSection.module.css";

/**
 * Cross-section job-file open mechanism:
 * When the user clicks the 🗂 button on a job thread header, we navigate to
 * `#jobs?file=<jobName>.md`. JobsSection reads the `?file=` query
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

// Kind display labels for the dropdown group headers
const KIND_LABELS: Record<string, string> = {
  job: "Jobs",
  web: "Web",
  discord: "Discord",
  agent: "Agents",
};

export function ChatsSection() {
  // Persist active session ID in the hash: #chats?id=<sessionId>
  const [activeIdRaw, setActiveIdFragment] = useFragmentState("id", "");
  const activeId = activeIdRaw || null;
  const setActiveId = useCallback(
    (id: string | null) => setActiveIdFragment(id ?? ""),
    [setActiveIdFragment],
  );

  const [showDetail, setShowDetail] = useState(!!activeId);

  // All sessions for the dropdown switcher
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [closedCount, setClosedCount] = useState(0);

  const loadSessions = useCallback(async () => {
    try {
      const sessions = await listSessions(true);
      const arr = Array.isArray(sessions) ? sessions : [];
      setAllSessions(arr);
      setClosedCount(arr.filter((s) => s.closed).length);
    } catch {
      // keep previous
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSessions();
  }, [loadSessions]);

  const handleSelect = useCallback(
    (id: string | null) => {
      setActiveId(id);
      if (id !== null) {
        setShowDetail(true);
      }
    },
    [setActiveId],
  );

  const handleBack = useCallback(() => {
    setShowDetail(false);
  }, []);

  // Active session label for the dropdown trigger
  const activeSession = allSessions.find((s) => s.id === activeId);
  const activeLabel = activeSession
    ? (activeSession.title ?? activeSession.agent ?? "Session")
    : null;

  // Threads grouped by kind (for dropdown)
  const openThreads = groupSessionsIntoThreads(
    allSessions.filter((s) => !s.closed),
  );

  // Accordion: default-expanded when no active thread; collapsed when one is active
  const activeThreadKey = activeSession
    ? getThreadKeyForSession(activeSession)
    : null;
  const accordionDefault = activeId ? "" : "threads";

  // Thread switcher dropdown — builds groups by kind
  const threadsByKind = new Map<string, typeof openThreads>();
  for (const thread of openThreads) {
    const arr = threadsByKind.get(thread.kind) ?? [];
    arr.push(thread);
    threadsByKind.set(thread.kind, arr);
  }

  const totalThreads = openThreads.length;

  return (
    <SectionFrame title="Chats" bodyClassName={styles.body as string}>
      <div
        className={[styles.layout, showDetail ? styles.detail : undefined]
          .filter(Boolean)
          .join(" ")}
      >
        {/* ── Accordion thread picker (CL1) ───────────────────────────────── */}
        <div className={styles.pickerRegion}>
          <Accordion
            type="single"
            defaultValue={accordionDefault}
            className={styles.accordion as string}
          >
            <AccordionItem value="threads">
              <AccordionTrigger
                itemValue="threads"
                className={styles.accordionTrigger as string}
              >
                <span className={styles.accordionTitle}>
                  Threads
                  <Badge variant="secondary" className="ml-2 text-[10px] px-[5px] py-0">
                    {totalThreads}
                  </Badge>
                </span>
              </AccordionTrigger>
              <AccordionContent
                itemValue="threads"
                className={styles.accordionContent as string}
              >
                <SessionsSidebar
                  activeId={activeId}
                  onSelect={handleSelect}
                  onOpenJob={openJobFile}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* ── DropdownMenu thread switcher when a thread is active (CL2) ── */}
          {activeId && activeLabel && (
            <div className={styles.switcherRow}>
              <DropdownMenu>
                <DropdownMenuTrigger className={styles.switcherTrigger as string}>
                  <span className={styles.switcherLabel}>{activeLabel}</span>
                  <ChevronDown size={14} className={styles.switcherChevron} />
                </DropdownMenuTrigger>
                <DropdownMenuContent glass align="start" className={styles.switcherMenu as string}>
                  <DropdownMenuItem
                    onSelect={() => {
                      handleSelect(null);
                    }}
                  >
                    <Plus size={13} className="mr-1" />
                    New
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />

                  {Array.from(threadsByKind.entries()).map(([kind, threads]) => (
                    <div key={kind}>
                      <DropdownMenuLabel>
                        {KIND_LABELS[kind] ?? kind}
                      </DropdownMenuLabel>
                      {threads.flatMap((thread) =>
                        thread.sessions.slice(0, 5).map((s) => (
                          <DropdownMenuItem
                            key={s.id}
                            onSelect={() => {
                              handleSelect(s.id);
                            }}
                          >
                            <span
                              className={[
                                styles.menuItem,
                                s.id === activeId ? styles.menuItemActive : undefined,
                              ]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              {s.title ?? s.agent ?? "Session"}
                            </span>
                          </DropdownMenuItem>
                        )),
                      )}
                    </div>
                  ))}

                  {closedCount > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled>
                        Show closed ({closedCount}) — use Threads panel
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/* ── Chat conversation pane ───────────────────────────────────────── */}
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
