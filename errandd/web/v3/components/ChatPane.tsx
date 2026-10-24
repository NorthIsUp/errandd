import { CircleCheck, CircleAlert, PanelRight, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiJSON } from "../../api/client";
import { useThreadSources } from "../hooks/useThreadSources";
import { useThreadStream } from "../hooks/useThreadStream";
import type { ThreadEntry } from "../lib/threadCatalog";
import { projectThreadContext } from "../lib/threadContext";
import { ThreadContext } from "./ThreadContext";
import { PartList } from "./parts/PartList";
import {
  ChatContainerContent,
  ChatContainerRoot,
  ChatContainerScrollAnchor,
} from "./prompt-kit/chat-container";
import { Loader } from "./prompt-kit/loader";
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "./prompt-kit/prompt-input";
import { PromptSuggestion } from "./prompt-kit/prompt-suggestion";
import { ScrollButton } from "./prompt-kit/scroll-button";
import { ThinkingBar } from "./prompt-kit/thinking-bar";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";

/** Canned composer replies surfaced when the thread is idle (spec §8). */
const SUGGESTIONS = ["approve", "explain the diff", "what changed?", "re-run the checks"];

/**
 * The chat pane for one thread (spec §6/§7/§8). Loads structured parts, streams
 * live deltas via `useThreadStream`, renders them with the prompt-kit part
 * renderers, and posts replies (with an optimistic echo) to
 * POST /api/v3/threads/:id/message.
 */
export function ChatPane({ threadId, threadInfo, onOpenSwitcher }: { threadId: string | null; threadInfo?: ThreadEntry; onOpenSwitcher?: () => void }) {
  const { parts, status, loading, connected, error, echoUserMessage, removeEcho, olderCount, loadingOlder, loadOlder } =
    useThreadStream(threadId);
  const queueSources = useThreadSources(threadId);
  const projected = useMemo(() => projectThreadContext(parts), [parts]);
  const sources = useMemo(() => [...new Map([...queueSources, ...projected.sources].map(source => [source.href, source])).values()], [queueSources, projected.sources]);
  const [contextOpen, setContextOpen] = useState(() => {
    try { return localStorage.getItem("errandd:v3:context") === "open"; } catch { return false; }
  });
  const contextToggleRef = useRef<HTMLButtonElement>(null);
  const closeContext = useCallback(() => { setContextOpen(false); contextToggleRef.current?.focus(); }, []);
  useEffect(() => {
    try { localStorage.setItem("errandd:v3:context", contextOpen ? "open" : "closed"); } catch { /* storage unavailable */ }
    if (!contextOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector("dialog[open]")) closeContext(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [contextOpen, closeContext]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const sendingRef = useRef(false);
  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    setDraft("");
    setSending(false);
    setSendError(null);
    sendingRef.current = false;
    return () => {
      requestGenerationRef.current = generation + 1;
    };
  }, [threadId]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!(text && threadId) || sendingRef.current || loading) {
        return;
      }
      const generation = requestGenerationRef.current;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      setDraft("");
      const echoId = echoUserMessage(text);
      try {
        const result = await apiJSON<{ ok: boolean }>(
          `/api/v3/threads/${encodeURIComponent(threadId)}/message`,
          {
            method: "POST",
            body: JSON.stringify({ text }),
          },
        );
        if (!result.ok) throw new Error("Message could not be queued");
      } catch (err) {
        if (requestGenerationRef.current === generation) {
          removeEcho(echoId);
          setDraft(text);
          setSendError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (requestGenerationRef.current === generation) {
          sendingRef.current = false;
          setSending(false);
        }
      }
    },
    [threadId, loading, echoUserMessage, removeEcho],
  );

  if (!threadId) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <div className="text-3xl">🦞</div>
          <div className="font-medium">Select a thread</div>
          <p className="text-sm opacity-60">Pick an item in the sidebar or jump to a thread.</p>
          {onOpenSwitcher && <Button variant="outline" onClick={onOpenSwitcher}>Jump to a thread · ⌘ K</Button>}
        </div>
      </div>
    );
  }

  // Keep a working indicator visible throughout queued and active turns.
  const isRunning = status === "running" || status === "queued";
  const showThinking = isRunning;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="v3-chat-header">
        <div className="v3-chat-heading"><h1>{threadInfo?.title ?? threadId.split(":hook:")[0]}</h1><p>{threadInfo?.subtitle ?? threadId}</p></div>
        <span className={cn("v3-chat-status", status === "error" ? "text-error" : isRunning ? "text-warning" : "text-success")} aria-live="polite">
          {status === "error" ? <CircleAlert size={14} aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
          {status === "queued" ? "Queued" : status === "running" ? "Working" : status === "error" ? "Failed" : loading ? "Loading…" : status === "done" ? "Done" : "Idle"}
        </span>
        <button ref={contextToggleRef} type="button" className="v3-context-toggle" aria-expanded={contextOpen} aria-controls="v3-thread-context" onClick={() => setContextOpen(open => !open)}><PanelRight size={15} aria-hidden="true" />Context</button>
        {!connected && <span className="text-xs text-base-content/50">Reconnecting…</span>}
      </header>
      <div className="v3-chat-layout"><div className="v3-chat-stream">
      <ChatContainerRoot className="relative min-h-0 flex-1">
        <ChatContainerContent className="mx-auto w-full max-w-3xl gap-0 px-4 py-6">
          {olderCount > 0 && <Button variant="outline" size="sm" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? "Loading…" : `Load earlier messages (${olderCount})`}
          </Button>}
          {loading && parts.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-sm text-base-content/60">
              <Loader variant="dots" size="sm" />
              Loading transcript…
            </div>
          ) : (
            <PartList parts={projected.conversation} paginated />
          )}

          {showThinking && (
            <div className="mt-4">
              <ThinkingBar text="Working" />
            </div>
          )}

          {error && !loading && (
            <div role="status" className="py-4 text-sm text-base-content/60">
              {error}
            </div>
          )}

          <ChatContainerScrollAnchor />
        </ChatContainerContent>

        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto">
            <ScrollButton />
          </div>
        </div>
      </ChatContainerRoot>


      {sendError && (
        <p role="alert" className="px-4 py-2 text-sm text-error">
          {sendError}
        </p>
      )}
      <Composer
        draft={draft}
        setDraft={setDraft}
        onSend={(text) => void send(text)}
        disabled={sending || loading}
        showSuggestions={parts.length === 0 && !loading}
      />
      </div>
      {contextOpen && <>
        <button type="button" className="v3-context-backdrop" aria-label="Close context panel" onClick={closeContext} />
        <ThreadContext documents={projected.documents} sources={sources} jobName={threadInfo?.jobName ?? threadId.split(":hook:")[0]?.replace(/^agent:/, "") ?? ""}
          olderCount={olderCount} loadingOlder={loadingOlder} onLoadOlder={loadOlder} onClose={closeContext} />
      </>}
      </div>
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  onSend,
  disabled,
  showSuggestions,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: (text: string) => void;
  disabled: boolean;
  showSuggestions: boolean;
}) {
  return (
    <div className="px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-3xl space-y-2">
        {showSuggestions && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <PromptSuggestion key={s} size="sm" onClick={() => onSend(s)}>
                {s}
              </PromptSuggestion>
            ))}
          </div>
        )}

        <PromptInput
          value={draft}
          onValueChange={setDraft}
          onSubmit={() => onSend(draft)}
          isLoading={disabled}
          className="border-base-300 bg-base-100"
        >
          <PromptInputTextarea placeholder="Reply to the agent…" />
          <PromptInputActions className="justify-end pt-1">
            <PromptInputAction tooltip="Send (Enter)">
              <Button
                type="button"
                size="icon"
                disabled={disabled || draft.trim().length === 0}
                onClick={() => onSend(draft)}
                className={cn("size-8 rounded-full")}
              >
                <Send className="size-4" />
              </Button>
            </PromptInputAction>
          </PromptInputActions>
        </PromptInput>
      </div>
    </div>
  );
}
