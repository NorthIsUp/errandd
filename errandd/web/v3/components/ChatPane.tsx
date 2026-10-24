import { ExternalLink, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJSON } from "../../api/client";
import { type ThreadSource, useThreadSources } from "../hooks/useThreadSources";
import { useThreadStream } from "../hooks/useThreadStream";
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
export function ChatPane({ threadId }: { threadId: string | null }) {
  const { parts, status, loading, connected, error, echoUserMessage, removeEcho, olderCount, loadingOlder, loadOlder } =
    useThreadStream(threadId);
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
          <p className="text-sm opacity-60">Pick a hook item in the sidebar to open its chat.</p>
        </div>
      </div>
    );
  }

  // Keep a working indicator visible throughout queued and active turns.
  const isRunning = status === "running" || status === "queued";
  const showThinking = isRunning;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        aria-live="polite"
        className="flex items-center justify-between border-b border-base-300 px-4 py-2 text-xs text-base-content/60"
      >
        <span>
          {status === "queued"
            ? "Message queued"
            : status === "running"
              ? "Agent working"
              : status === "error"
                ? "Run failed"
                : "Thread"}
        </span>
        <span>{connected ? "Live" : "Reconnecting…"}</span>
      </div>
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
            <PartList parts={parts} paginated />
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

      <ThreadSources threadId={threadId} />

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
    <div className="border-t border-base-300 bg-base-100 px-4 py-3">
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
          className="border-base-300 bg-base-200"
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

const SOURCE_DOT: Record<ThreadSource["kind"], string> = {
  github: "bg-primary",
  linear: "bg-secondary",
  sentry: "bg-error",
  datadog: "bg-warning",
};

/** Cross-reference links for the thread (PR, Linear ticket, …), shown just
 *  above the chatbox composer. */
function ThreadSources({ threadId }: { threadId: string }) {
  const sources = useThreadSources(threadId);
  if (sources.length === 0) {
    return null;
  }
  // The routine handling this thread is the threadId prefix before `:hook:`
  // (`<jobName>:hook:<scope>`, or `agent:<agent>:hook:<scope>`). Surface it as
  // the `<jobName>.md` file so the bar reads `pr-accepted.md │ sources …`.
  const routine = threadId.split(":hook:")[0]?.replace(/^agent:/, "") || "";
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-base-300 bg-base-100/60 px-4 py-2">
      {routine ? (
        <span className="font-mono text-[11px] text-base-content/60">{routine}.md</span>
      ) : null}
      <span className="font-mono text-[10px] uppercase tracking-wide text-base-content/30">│</span>
      <span className="font-mono text-[10px] uppercase tracking-wide text-base-content/40">
        sources
      </span>
      {sources.map((s) => (
        <a
          key={s.href}
          href={s.href}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1.5 rounded-full border border-base-300 bg-base-200/60 px-2.5 py-1 font-mono text-[11px] text-base-content/70 transition-colors hover:border-secondary hover:text-secondary"
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", SOURCE_DOT[s.kind])} />
          {s.label}
          <ExternalLink className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
        </a>
      ))}
    </div>
  );
}
