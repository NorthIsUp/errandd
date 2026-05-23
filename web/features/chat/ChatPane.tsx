import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "../../api/chat";
import { streamChat } from "../../api/chat";
import { createJobFile, writeJobFile } from "../../api/jobs";
import {
  getSessionEffort,
  getSessionGoal,
  getSessionMessages,
  getSessionModel,
  setSessionEffort,
  setSessionGoal,
  setSessionModel,
} from "../../api/sessions";
import { ChatInput } from "./ChatInput";
import type { ChatMessageData } from "./ChatMessage";
import { ChatMessage } from "./ChatMessage";
import styles from "./ChatPane.module.css";
import { PrefsBanner } from "./PrefsBanner";
import {
  isClientSlashCommand,
  parseClientSlashCommand,
  parseLoopArgs,
  prettyCron,
} from "./slashIntercept";
import { useSlashEntries } from "./useSlashEntries";

const BROWSE_PAGE = 10;
const VALID_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

interface Props {
  activeId: string | null;
  onActiveIdChanged: (id: string | null) => void;
  onBack?: () => void;
}

/**
 * Right pane: messages list + prefs banner + input form.
 * Handles streaming, history paging, attachments, client slash intercepts.
 */
export function ChatPane({
  activeId,
  onActiveIdChanged: _onActiveIdChanged,
  onBack,
}: Props) {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [busy, setBusy] = useState(false);
  const [browseOffset, setBrowseOffset] = useState(0);
  const [_browseTotalCount, setBrowseTotalCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Prefs banner state
  const [goal, setGoal] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<string>("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyStartRef = useRef<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { entries: slashEntries, refresh: refreshSlash } = useSlashEntries();

  // Scroll to bottom — stable reference (ref-based, no re-renders)
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Fetch session prefs
  const fetchPrefs = useCallback(async (sessionId: string) => {
    try {
      const [gd, md, ed] = await Promise.all([
        getSessionGoal(sessionId).catch(() => ({ goal: "" })),
        getSessionModel(sessionId).catch(() => ({ model: "" })),
        getSessionEffort(sessionId).catch(() => ({ effort: "" })),
      ]);
      setGoal(gd.goal ?? "");
      setModel(md.model ?? "");
      setEffort(ed.effort ?? "");
    } catch {
      setGoal("");
      setModel("");
      setEffort("");
    }
  }, []);

  // Load messages for the active session
  const loadMessages = useCallback(
    async (sessionId: string) => {
      try {
        const result = await getSessionMessages(sessionId, BROWSE_PAGE, -1);
        const msgs = Array.isArray(result.messages) ? result.messages : [];
        const total =
          typeof result.total === "number" ? result.total : msgs.length;
        setBrowseTotalCount(total);
        setBrowseOffset(Math.max(0, total - BROWSE_PAGE));
        setMessages(
          msgs.map((m) => ({
            role: m.role as "user" | "assistant",
            text: m.text,
            timestamp: m.timestamp ?? null,
          })),
        );
        setTimeout(scrollToBottom, 50);
      } catch {
        // ignore
      }
    },
    [scrollToBottom],
  );

  // Load older messages
  async function loadMore() {
    if (!activeId || browseOffset <= 0) return;
    const newOffset = Math.max(0, browseOffset - BROWSE_PAGE);
    const limit = browseOffset - newOffset;
    if (limit <= 0) return;
    try {
      const result = await getSessionMessages(activeId, limit, newOffset);
      const older = Array.isArray(result.messages) ? result.messages : [];
      setBrowseOffset(newOffset);
      setMessages((prev) => [
        ...older.map((m) => ({
          role: m.role as "user" | "assistant",
          text: m.text,
          timestamp: m.timestamp ?? null,
        })),
        ...prev,
      ]);
    } catch {
      // ignore
    }
  }

  // Effect: load when activeId changes
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    // Synchronous resets are intentional here (clearing stale data when
    // active session changes). The async loads below call setState in callbacks.
    if (!activeId) {
      setMessages([]);
      setBrowseOffset(0);
      setBrowseTotalCount(0);
      setGoal("");
      setModel("");
      setEffort("");
      return;
    }
    setMessages([]);
    setBrowseOffset(0);
    setBrowseTotalCount(0);
    /* eslint-enable react-hooks/set-state-in-effect */
    void loadMessages(activeId); // async — setState in promise resolution
    void fetchPrefs(activeId); // async — setState in promise resolution
    refreshSlash();
  }, [activeId, loadMessages, fetchPrefs, refreshSlash]);

  // Busy timer
  function startBusy() {
    setBusy(true);
    busyStartRef.current = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - busyStartRef.current);
    }, 1000);
  }

  function stopBusy() {
    setBusy(false);
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    abortRef.current = null;
    setElapsedMs(0);
  }

  // Append a system bubble (text or HTML)
  function appendSystemBubble(html: string) {
    setMessages((prev) => [...prev, { role: "system", text: html }]);
    setTimeout(scrollToBottom, 50);
  }

  // ── Client slash intercepts ──
  async function handleGoal(arg: string) {
    if (!arg) {
      if (!activeId) {
        appendSystemBubble("no goal set (no active session)");
        return;
      }
      try {
        const gd = await getSessionGoal(activeId);
        appendSystemBubble(
          gd.goal ? `Goal: <em>${escHtml(gd.goal)}</em>` : "no goal set",
        );
      } catch (e) {
        appendSystemBubble(`Error fetching goal: ${escHtml(String(e))}`);
      }
      return;
    }
    if (arg === "clear") {
      if (activeId) {
        await setSessionGoal(activeId, "").catch(() => {});
      }
      setGoal("");
      appendSystemBubble("Goal cleared.");
      return;
    }
    if (activeId) {
      await setSessionGoal(activeId, arg).catch(() => {});
    }
    setGoal(arg);
    appendSystemBubble(`Goal set: <em>${escHtml(arg)}</em>`);
  }

  async function handleModel(arg: string) {
    if (!arg) {
      if (!activeId) {
        appendSystemBubble("no model set (no active session)");
        return;
      }
      try {
        const md = await getSessionModel(activeId);
        appendSystemBubble(
          md.model
            ? `Model for this session: <em>${escHtml(md.model)}</em>`
            : "Model: (using global default)",
        );
      } catch (e) {
        appendSystemBubble(`Error fetching model: ${escHtml(String(e))}`);
      }
      return;
    }
    if (arg === "clear") {
      if (activeId) {
        await setSessionModel(activeId, "").catch(() => {});
      }
      setModel("");
      appendSystemBubble("Model cleared (using global default).");
      return;
    }
    if (activeId) {
      await setSessionModel(activeId, arg).catch(() => {});
    }
    setModel(arg);
    appendSystemBubble(`Model set: <em>${escHtml(arg)}</em>`);
  }

  async function handleEffort(arg: string) {
    if (!arg) {
      if (!activeId) {
        appendSystemBubble("no effort set (no active session)");
        return;
      }
      try {
        const ed = await getSessionEffort(activeId);
        appendSystemBubble(
          ed.effort
            ? `Effort for this session: <em>${escHtml(ed.effort)}</em>`
            : "Effort: (using default)",
        );
      } catch (e) {
        appendSystemBubble(`Error fetching effort: ${escHtml(String(e))}`);
      }
      return;
    }
    if (arg === "clear") {
      if (activeId) {
        await setSessionEffort(activeId, "").catch(() => {});
      }
      setEffort("");
      appendSystemBubble("Effort cleared (using default).");
      return;
    }
    if (!VALID_EFFORT_LEVELS.includes(arg)) {
      appendSystemBubble(
        `Invalid effort level: <em>${escHtml(arg)}</em>. Use: low, medium, high, xhigh, max`,
      );
      return;
    }
    if (activeId) {
      await setSessionEffort(activeId, arg).catch(() => {});
    }
    setEffort(arg);
    appendSystemBubble(`Effort set: <em>${escHtml(arg)}</em>`);
  }

  async function handleLoop(arg: string) {
    const parsed = parseLoopArgs(arg);
    if (!parsed.ok) {
      appendSystemBubble(`Error: ${escHtml(parsed.error)}`);
      return;
    }
    const { cron, prompt } = parsed;
    const pretty = prettyCron(cron);

    // Build date-sortable filename
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fname = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
    const content = `---\nschedule: "${cron}"\nrecurring: true\nnotify: false\nreuse_session: false\n---\n${prompt}\n`;

    // Determine first repo slug
    let repoSlug: string | null = null;
    try {
      const repos = (await fetch("/api/jobs/repos").then((r) =>
        r.json(),
      )) as Array<{ slug?: string }>;
      if (Array.isArray(repos) && repos.length > 0 && repos[0]?.slug) {
        repoSlug = repos[0].slug;
      }
    } catch {
      // ignore
    }

    try {
      await createJobFile(fname, repoSlug);
      await writeJobFile(fname, content, repoSlug);
      // System bubble with a link to open the job in Jobs section.
      // Cross-section mechanism: navigate to #jobs?file=<fname> —
      // JobsSection reads the ?file= query param to open the file directly.
      const encodedFile = encodeURIComponent(fname);
      const encodedRepo = repoSlug
        ? `&repo=${encodeURIComponent(repoSlug)}`
        : "";
      appendSystemBubble(
        `Created job <a href="#jobs?file=${encodedFile}${encodedRepo}">${escHtml(fname)}</a> (${escHtml(pretty)})`,
      );
    } catch (e) {
      appendSystemBubble(
        `Error creating job: ${escHtml(e instanceof Error ? e.message : String(e))}`,
      );
    }
  }

  // ── Send message ──
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleGoal/handleModel/handleEffort/handleLoop/startBusy/scrollToBottom are all defined in component scope and recreated on each render — activeId is the only external dep that matters
  const handleSend = useCallback(
    async (text: string, attachments: ChatAttachment[]) => {
      // Client-side slash intercepts (only if no attachments)
      if (attachments.length === 0 && isClientSlashCommand(text)) {
        const cmd = parseClientSlashCommand(text);
        if (cmd) {
          if (cmd.name === "goal") void handleGoal(cmd.arg);
          else if (cmd.name === "model") void handleModel(cmd.arg);
          else if (cmd.name === "effort") void handleEffort(cmd.arg);
          else if (cmd.name === "loop") void handleLoop(cmd.arg);
          return;
        }
      }

      // Add user message
      const userText =
        text ||
        `(${attachments.length} attachment${attachments.length !== 1 ? "s" : ""})`;

      const userMsg: ChatMessageData = {
        role: "user",
        text: userText,
        timestamp: new Date().toISOString(),
      };
      const streamingMsg: ChatMessageData = {
        role: "assistant",
        text: "",
        streaming: true,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMsg, streamingMsg]);
      startBusy();
      setTimeout(scrollToBottom, 50);

      const abort = new AbortController();
      abortRef.current = abort;
      let assistantIdx = -1;

      setMessages((prev) => {
        assistantIdx = prev.length - 1;
        return prev;
      });

      // We need a stable index; capture it after the state updates
      let capturedIdx: number | undefined;

      await new Promise<void>((resolve) => {
        setMessages((prev) => {
          capturedIdx = prev.length - 1;
          return prev;
        });
        // Use setTimeout 0 to allow the state to settle
        setTimeout(async () => {
          const chatOpts = {
            message: text,
            attachments,
            signal: abort.signal,
            ...(activeId != null ? { sessionId: activeId } : {}),
          };
          await streamChat(chatOpts, {
            onChunk: (chunk) => {
              setMessages((prev) => {
                const copy = [...prev];
                const idx = copy.length - 1;
                const last = copy[idx];
                if (last?.role === "assistant" || last?.streaming) {
                  copy[idx] = {
                    ...last,
                    text: (last.text ?? "") + chunk,
                    streaming: true,
                  };
                }
                return copy;
              });
              setTimeout(scrollToBottom, 10);
            },
            onUnblock: () => {
              stopBusy();
              setMessages((prev) => {
                const copy = [...prev];
                const idx = copy.length - 1;
                const last = copy[idx];
                if (last)
                  copy[idx] = { ...last, streaming: false, background: true };
                return copy;
              });
            },
            onAgentSpawn: (id, description) => {
              setMessages((prev) => [
                ...prev,
                {
                  role: "agent",
                  agentId: id,
                  text: `🤖 Sub-agent started: ${description}`,
                  agentStatus: "running",
                },
              ]);
            },
            onAgentDone: (id, description) => {
              setMessages((prev) => {
                const copy = [...prev];
                let agentIdx = -1;
                for (let k = copy.length - 1; k >= 0; k--) {
                  if (copy[k]?.role === "agent" && copy[k]?.agentId === id) {
                    agentIdx = k;
                    break;
                  }
                }
                if (agentIdx >= 0) {
                  const m = copy[agentIdx];
                  if (m)
                    copy[agentIdx] = {
                      ...m,
                      agentStatus: "done",
                      text: `✅ Sub-agent done: ${description}`,
                    };
                } else {
                  copy.push({
                    role: "agent",
                    agentId: id,
                    text: `✅ Sub-agent done: ${description}`,
                    agentStatus: "done",
                  });
                }
                return copy;
              });
            },
            onDone: () => {
              setMessages((prev) => {
                const copy = [...prev];
                const idx = copy.length - 1;
                const last = copy[idx];
                if (last)
                  copy[idx] = { ...last, streaming: false, background: false };
                return copy;
              });
              // Check if we got a session ID from the response
              stopBusy();
              setTimeout(scrollToBottom, 50);
              resolve();
            },
            onError: (err) => {
              const cancelled = err.name === "AbortError";
              setMessages((prev) => {
                const copy = [...prev];
                const idx = copy.length - 1;
                const last = copy[idx];
                if (last) {
                  copy[idx] = {
                    ...last,
                    streaming: false,
                    background: false,
                    text: cancelled
                      ? last.text || "[Cancelled]"
                      : `[Failed: ${String(err)}]`,
                  };
                }
                return copy;
              });
              stopBusy();
              resolve();
            },
          });
        }, 0);
      });

      void assistantIdx;
      void capturedIdx;

      setTimeout(scrollToBottom, 100);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId],
  );

  function handleCancel() {
    abortRef.current?.abort();
  }

  // Prefs banner clear handlers
  async function clearGoal() {
    if (activeId) await setSessionGoal(activeId, "").catch(() => {});
    setGoal("");
    appendSystemBubble("Goal cleared.");
  }

  async function clearModel() {
    if (activeId) await setSessionModel(activeId, "").catch(() => {});
    setModel("");
    appendSystemBubble("Model cleared (using global default).");
  }

  async function clearEffort() {
    if (activeId) await setSessionEffort(activeId, "").catch(() => {});
    setEffort("");
    appendSystemBubble("Effort cleared (using default).");
  }

  const showLoadMore = activeId !== null && browseOffset > 0;

  return (
    <div className={styles.pane}>
      {/* History banner */}
      {activeId && (
        <div className={styles.historyBanner}>
          {onBack && (
            <button type="button" className={styles.backBtn} onClick={onBack}>
              ← Back
            </button>
          )}
          <span className={styles.historyBannerLabel}>
            Browsing session history
          </span>
        </div>
      )}

      {/* Load older button */}
      {showLoadMore && (
        <div className={styles.loadMore}>
          <button
            type="button"
            className={styles.loadMoreBtn}
            onClick={() => {
              void loadMore();
            }}
          >
            Load older ({browseOffset} more)
          </button>
        </div>
      )}

      {/* Messages */}
      <div className={styles.messages}>
        {messages.length === 0 ? (
          <div className={styles.empty}>
            Send a message to start chatting with the daemon.
          </div>
        ) : (
          messages.map((msg, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: messages don't have stable IDs; order is append-only
            <ChatMessage key={idx} message={msg} elapsedMs={elapsedMs} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Prefs banner */}
      <PrefsBanner
        goal={goal}
        model={model}
        effort={effort}
        onClearGoal={() => {
          void clearGoal();
        }}
        onClearModel={() => {
          void clearModel();
        }}
        onClearEffort={() => {
          void clearEffort();
        }}
      />

      {/* Chat input */}
      <ChatInput
        busy={busy}
        slashEntries={slashEntries}
        onSend={(text, atts) => {
          void handleSend(text, atts);
        }}
        onCancel={handleCancel}
      />
    </div>
  );
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
