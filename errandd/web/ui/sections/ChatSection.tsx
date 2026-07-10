import { ArrowLeft, Plus, RotateCcw, Send } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { resetChatSession, streamChat } from "../../api/chat";
import {
  type ChatMessage,
  getHookPayload,
  getSessionMessages,
  listSessions,
  type MessagesResult,
  type SessionInfo,
  type SessionTrigger,
  setSessionClosed,
} from "../../api/sessions";
import { Card } from "../components/Card";
import { Disclosure } from "../components/Disclosure";
import { MarkdownView } from "../components/MarkdownView";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { Pills } from "../components/Pills";
import { ResumeDivider } from "../components/ResumeDivider";
import { ToolCard } from "../components/ToolCard";
import { dedupRefs, extractRefs, type Ref } from "../refs";
import { useRoute } from "../router";
import { parseToolFragments } from "../toolBlocks";
import { useAsync } from "../useAsync";

/** Threshold between an assistant turn and the next user turn that we treat
 *  as the user re-engaging a quiet session. */
const RESUME_GAP_MS = 5 * 60 * 1000;

/** Stable empty-messages fallback: a fresh `[]` each render would change the
 *  identity of `messages` every render and thrash the memos keyed on it. */
const EMPTY_MESSAGES: ChatMessage[] = [];

export function ChatSection() {
  const { route } = useRoute();
  const sessionId = route.segments[0];

  if (sessionId) {
    return <SessionView sessionId={sessionId} />;
  }
  return <ChatBrowser />;
}

// ---------------------------------------------------------------------------
// Browser: list ALL sessions (open + closed) with a filter.
// ---------------------------------------------------------------------------

function ChatBrowser() {
  const { goto } = useRoute();
  const sessions = useAsync<SessionInfo[]>(() => listSessions(true));
  const [query, setQuery] = useState("");
  const [msgs, setMsgs] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const all = sessions.data ?? [];
    const q = query.trim().toLowerCase();
    const list = q
      ? all.filter((s) =>
          [s.title, s.firstMessage, s.lastMessage, s.jobName, s.agent, s.id]
            .filter(Boolean)
            .some((v) => (v ?? "").toLowerCase().includes(q)),
        )
      : all;
    return [...list].sort((a, b) =>
      a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0,
    );
  }, [sessions.data, query]);

  async function onNewChat() {
    abortRef.current?.abort();
    setStreaming(false);
    setMsgs([]);
    setErr(null);
    try {
      await resetChatSession();
      sessions.reload();
    } catch (e) {
      setErr(e);
    }
  }

  function onSend() {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }
    setInput("");
    setErr(null);
    setMsgs((m) => [
      ...m,
      { id: ++bubbleSeq, role: "user", text },
      { id: ++bubbleSeq, role: "assistant", text: "" },
    ]);
    setStreaming(true);
    abortRef.current = new AbortController();
    void streamChat(
      { message: text, signal: abortRef.current.signal },
      {
        onChunk: (chunk) =>
          setMsgs((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, text: last.text + chunk };
            }
            return next;
          }),
        onDone: () => {
          setStreaming(false);
          sessions.reload();
        },
        onError: (e) => {
          setErr(e);
          setStreaming(false);
        },
      },
    );
  }

  return (
    <>
      <PageHeader
        title="Chat"
        crumbs={[{ label: "Chat" }]}
        actions={
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void onNewChat()}>
            <Plus size={16} /> New chat
          </button>
        }
      />

      <Card title={`All sessions (${(sessions.data ?? []).length})`}>
        {sessions.loading && <Loader />}
        {sessions.error ? <ErrorBanner error={sessions.error} /> : null}
        {sessions.data?.length === 0 && <Empty>No sessions yet.</Empty>}
        {sessions.data && sessions.data.length > 0 && (
          <>
            <input
              type="search"
              className="input input-bordered input-sm w-full mb-3"
              placeholder="Search title, message, job, agent, or id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {filtered.length === 0 ? (
              <Empty>No sessions match the search.</Empty>
            ) : (
              <ul className="divide-y divide-base-300 -mx-1 max-h-[40vh] overflow-y-auto">
                {filtered.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => goto("chat", [s.id])}
                      className="w-full text-left px-2 py-2 hover:bg-base-200 rounded"
                    >
                      <div className="flex items-baseline justify-between gap-2 min-w-0">
                        <span className="font-medium truncate">{friendlyName(s)}</span>
                        <span className="text-xs text-base-content/60 shrink-0 tabular-nums">
                          {s.turnCount} · {new Date(s.lastUsedAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="text-xs text-base-content/60 truncate flex items-center gap-1">
                        {s.jobName && (
                          <span className="badge badge-ghost badge-xs">{s.jobName}</span>
                        )}
                        <span className="badge badge-ghost badge-xs">{s.channel}</span>
                        {s.closed && <span className="badge badge-ghost badge-xs">closed</span>}
                        {(s.lastMessage || s.firstMessage) && (
                          <span className="truncate ml-1 italic">
                            {(s.lastMessage || s.firstMessage).slice(0, 80)}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <Card title="Active chat">
        <div ref={scrollRef} className="h-[50vh] overflow-y-auto overflow-x-hidden space-y-3 min-w-0" aria-live="polite">
          {msgs.length === 0 && (
            <p className="text-sm italic text-base-content/60 text-center mt-12">
              Send a message to start a chat.
            </p>
          )}
          {msgs.map((m, i) => (
            <div key={m.id} className={`chat ${m.role === "user" ? "chat-end" : "chat-start"}`}>
              <div
                className={`chat-bubble whitespace-pre-wrap break-words max-w-full ${
                  m.role === "user" ? "chat-bubble-primary" : ""
                }`}
              >
                {m.text || (streaming && i === msgs.length - 1 ? "…" : "")}
              </div>
            </div>
          ))}
        </div>

        {err ? <ErrorBanner error={err} /> : null}

        <form
          className="join w-full mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <input
            type="text"
            className="input input-bordered join-item flex-1"
            placeholder="Message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={streaming}
            aria-label="Message"
          />
          <button
            type="submit"
            className="btn btn-primary join-item"
            disabled={streaming || !input.trim()}
          >
            <Send size={16} />
            <span className="hidden sm:inline">Send</span>
          </button>
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Single-session viewer: shows the full transcript with pagination.
// ---------------------------------------------------------------------------

const PAGE = 50;

interface LiveTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** Inline tool/agent cards that appeared during streaming, oldest first. */
  tools: { id: string; name: string; description: string; pending: boolean }[];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tab-level component composes transcript + composer + reopen + pills; pieces already extracted to helpers.
function SessionView({ sessionId }: { sessionId: string }) {
  const { goto } = useRoute();
  const [offset, setOffset] = useState(0);
  const [meta, setMeta] = useState<SessionInfo | null>(null);
  const result = useAsync<MessagesResult>(
    () => getSessionMessages(sessionId, PAGE, offset),
    `${sessionId}:${offset}`,
  );

  const [liveTurns, setLiveTurns] = useState<LiveTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [reopening, setReopening] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    listSessions(true)
      .then((all) => {
        if (cancelled) {
          return;
        }
        setMeta(all.find((s) => s.id === sessionId) ?? null);
      })
      .catch((e) => {
        console.error("session metadata fetch failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const total = result.data?.total ?? 0;
  const messages = result.data?.messages ?? EMPTY_MESSAGES;
  const hasMore = offset + messages.length < total;

  // Aggregate references from the whole loaded transcript + any live turns,
  // so the pill bar surfaces every PR/Linear ref the session has touched.
  const refs: Ref[] = useMemo(() => {
    const all: Ref[] = [];
    for (const m of messages) {
      all.push(...extractRefs(m.text));
    }
    for (const t of liveTurns) {
      all.push(...extractRefs(t.text));
    }
    return dedupRefs(all);
  }, [messages, liveTurns]);

  // Resume points: between consecutive transcript messages where the gap
  // from an assistant turn → next user turn exceeds RESUME_GAP_MS.
  const resumeBefore = useMemo(() => findResumePoints(messages), [messages]);

  function onSend() {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }
    setInput("");
    setErr(null);
    setLiveTurns((t) => [
      ...t,
      { id: ++turnSeq, role: "user", text, tools: [] },
      { id: ++turnSeq, role: "assistant", text: "", tools: [] },
    ]);
    setStreaming(true);
    abortRef.current = new AbortController();
    void streamChat(
      { message: text, sessionId, signal: abortRef.current.signal },
      {
        ...makeTurnHandlers(setLiveTurns),
        onDone: () => {
          setStreaming(false);
        },
        onError: (e) => {
          setErr(e);
          setStreaming(false);
        },
      },
    );
  }

  // Jump to the most recent message once the transcript has actually
  // rendered (the data arrives async, so an on-mount scroll would land on an
  // empty container) and whenever a live turn streams in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on transcript load + live-turn growth; scrollRef is stable
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [result.data, liveTurns]);

  async function onReopen() {
    setReopening(true);
    try {
      await setSessionClosed(sessionId, false);
      setMeta((m) => (m ? { ...m, closed: false } : m));
    } catch (e) {
      setErr(e);
    } finally {
      setReopening(false);
    }
  }

  const title = meta ? friendlyName(meta) : sessionId.slice(0, 8);

  return (
    <>
      <PageHeader
        title={title}
        crumbs={[{ label: "Chat", onClick: () => goto("chat") }, { label: title }]}
        actions={
          <button type="button" className="btn btn-sm" onClick={() => goto("chat")}>
            <ArrowLeft size={16} /> Back
          </button>
        }
      />

      {meta && (
        <Card>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/70">
              <span className="badge badge-ghost">{meta.channel}</span>
              {meta.jobName && <span className="badge badge-ghost">{meta.jobName}</span>}
              {meta.closed && <span className="badge badge-warning">closed</span>}
              <span>
                {meta.turnCount} turn{meta.turnCount === 1 ? "" : "s"}
              </span>
              <span>· {new Date(meta.lastUsedAt).toLocaleString()}</span>
              <span className="ml-auto font-mono">{sessionId.slice(0, 12)}</span>
            </div>
            {refs.length > 0 && <Pills refs={refs} />}
          </div>
        </Card>
      )}

      <Card title={`Transcript (${total})`}>
        {result.loading && <Loader />}
        {result.error ? <ErrorBanner error={result.error} /> : null}
        {result.data && messages.length === 0 && liveTurns.length === 0 && (
          <Empty>No messages.</Empty>
        )}
        <div
          ref={scrollRef}
          className="space-y-3 max-h-[60vh] overflow-y-auto overflow-x-hidden min-w-0"
        >
          {messages.map((m, i) => (
            <div key={`${m.uuid ?? i}`}>
              {resumeBefore.has(i) && <ResumeDivider at={m.timestamp} />}
              <TranscriptBubble m={m} trigger={meta?.trigger} sessionId={sessionId} />
            </div>
          ))}
          {liveTurns.length > 0 && messages.length > 0 && (
            // Cosmetic "resumed here" divider between the loaded transcript and
            // the live turns; the exact wall-clock instant is immaterial.
            // eslint-disable-next-line @eslint-react/purity
            <ResumeDivider at={new Date().toISOString()} />
          )}
          {liveTurns.map((t, i) => (
            <LiveBubble key={t.id} turn={t} streaming={streaming && i === liveTurns.length - 1} />
          ))}
        </div>
        {hasMore && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setOffset(offset + PAGE)}
              disabled={result.loading}
            >
              Load more
            </button>
          </div>
        )}

        {err ? <ErrorBanner error={err} /> : null}

        {meta?.closed ? (
          <div className="mt-3 flex items-center justify-between gap-3 text-sm rounded-box border border-base-300 bg-base-200 px-3 py-2">
            <span className="text-base-content/70">
              This session is closed. Reopen it to continue.
            </span>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void onReopen()}
              disabled={reopening}
            >
              <RotateCcw size={16} /> {reopening ? "Reopening…" : "Reopen"}
            </button>
          </div>
        ) : (
          <form
            className="join w-full mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <input
              type="text"
              className="input input-bordered join-item flex-1"
              placeholder="Continue this chat…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={streaming}
              aria-label="Message"
            />
            <button
              type="submit"
              className="btn btn-primary join-item"
              disabled={streaming || !input.trim()}
            >
              <Send size={16} />
              <span className="hidden sm:inline">Send</span>
            </button>
          </form>
        )}
      </Card>
    </>
  );
}

function TranscriptBubble({
  m,
  trigger,
  sessionId,
}: {
  m: ChatMessage;
  trigger?: SessionTrigger | undefined;
  sessionId: string;
}) {
  const isUser = m.role === "user";
  const fragments = isUser ? null : parseToolFragments(m.text);

  // Routine terminator lines (`[skip] …`, `[ok] …`, `[error] …`) are
  // structural status markers, not conversational replies. Render them
  // as centered system bubbles without a tail so they read as state
  // changes, not back-and-forth.
  if (!isUser && isSystemMarker(m.text)) {
    return (
      <SystemBubble
        text={m.text.trim()}
        timestamp={m.timestamp}
        trigger={trigger}
        sessionId={sessionId}
      />
    );
  }

  return (
    <div className={`chat ${isUser ? "chat-end" : "chat-start"}`}>
      <div className="chat-header text-xs opacity-70">
        {m.role}
        {m.timestamp && <span className="ml-2">{new Date(m.timestamp).toLocaleTimeString()}</span>}
      </div>
      <div className={`chat-bubble break-words max-w-full ${isUser ? "chat-bubble-primary" : ""}`}>
        {isUser || !fragments || fragments.length <= 1 ? (
          <CollapsibleText text={m.text} />
        ) : (
          fragments.map((f, i) => {
            const fragKey = `${i}:${f.kind === "text" ? f.text.slice(0, 32) : `${f.name}:${f.call.slice(0, 32)}`}`;
            return f.kind === "text" ? (
              <CollapsibleText key={fragKey} text={f.text} />
            ) : (
              <ToolCard key={fragKey} name={f.name} call={f.call} result={f.result} />
            );
          })
        )}
      </div>
    </div>
  );
}

/** Wrap a long text block in a "Show more" toggle. The initial render
 *  shows the first ~10 lines (or ~600 chars, whichever is shorter);
 *  clicking expands to the full content. Short text passes through
 *  untouched so most bubbles stay normal. */
const COLLAPSE_LINE_LIMIT = 10;
const COLLAPSE_CHAR_LIMIT = 600;
function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const needsCollapse =
    lines.length > COLLAPSE_LINE_LIMIT || text.length > COLLAPSE_CHAR_LIMIT;
  // Render markdown for the shown slice. When collapsed we truncate the raw
  // source first; MarkdownView is tolerant of a clipped tail.
  const shown =
    !needsCollapse || expanded
      ? text
      : lines.slice(0, COLLAPSE_LINE_LIMIT).join("\n").slice(0, COLLAPSE_CHAR_LIMIT);
  const hiddenLines = Math.max(0, lines.length - COLLAPSE_LINE_LIMIT);
  return (
    <>
      <MarkdownView source={shown} />
      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs underline opacity-80 hover:opacity-100 mt-1"
          aria-label={expanded ? "Show less" : "Show full message"}
        >
          {expanded
            ? "Show less"
            : `… show more${hiddenLines > 0 ? ` (${hiddenLines} more line${hiddenLines === 1 ? "" : "s"})` : ""}`}
        </button>
      )}
    </>
  );
}

/** True when the assistant message is a routine terminator — starts
 *  with `[skip]`, `[ok]`, or `[error]` and is short enough to be a
 *  one-line status (not a longer reply that happens to begin that way). */
function isSystemMarker(text: string): boolean {
  const trimmed = text.trim();
  if (!/^\[(skip|ok|error)\]/i.test(trimmed)) return false;
  // Cap so an unusually long status doesn't blow up the centered pill.
  return trimmed.length <= 300 && !trimmed.includes("\n\n");
}

function SystemBubble({
  text,
  timestamp,
  trigger,
  sessionId,
}: {
  text: string;
  timestamp?: string;
  trigger?: SessionTrigger | undefined;
  sessionId: string;
}) {
  // No chat-start / chat-end → no bubble tail. Centered horizontally and
  // tonally distinct from the conversational bubbles around it.
  const kind = (/^\[(\w+)\]/i.exec(text))?.[1]?.toLowerCase() ?? "info";
  const tone =
    kind === "ok"
      ? "badge-success"
      : kind === "error"
        ? "badge-error"
        : "badge-ghost";
  const badge = (
    <span
      className={`badge ${tone} badge-lg font-mono whitespace-pre-wrap break-words max-w-full px-3 py-2 h-auto`}
    >
      {text}
    </span>
  );
  // When the session was kicked off by a webhook, fold the key hook fields
  // into a disclosure behind the status badge — it explains *why* this run
  // exists (which event/PR/actor) without cluttering the transcript.
  const hook = trigger?.kind === "hook" ? trigger : null;
  return (
    <div className="flex justify-center my-2">
      <div className="flex flex-col items-center gap-1 max-w-full w-full sm:max-w-xl">
        {hook ? (
          <div className="w-full font-sans space-y-1">
            <Disclosure summary={badge}>
              <HookSummary hook={hook} />
            </Disclosure>
            <HookPayloadDisclosure sessionId={sessionId} />
          </div>
        ) : (
          badge
        )}
        {timestamp && (
          <span className="text-[10px] text-base-content/50">
            {new Date(timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

/** Return `url` only if it's a plain http(s) link, else null — guards the
 *  rendered <a href> against `javascript:`/`data:` schemes sneaking in via a
 *  webhook payload. */
function httpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Pretty key/value breakdown of the webhook that triggered this session. */
function HookSummary({ hook }: { hook: Extract<SessionTrigger, { kind: "hook" }> }) {
  const provider = hook.event.startsWith("sentry:")
    ? "Sentry"
    : hook.event.startsWith("datadog:")
      ? "Datadog"
      : "GitHub";
  const rows: { label: string; value: ReactNode }[] = [{ label: "Source", value: provider }];
  rows.push({ label: "Event", value: <code className="font-mono">{hook.event}</code> });
  if (hook.action) rows.push({ label: "Action", value: <code className="font-mono">{hook.action}</code> });
  if (hook.repo) rows.push({ label: "Repo", value: <code className="font-mono">{hook.repo}</code> });
  if (hook.pr) {
    const safeUrl = hook.pr.url ? httpUrl(hook.pr.url) : null;
    rows.push({
      label: "PR",
      value: safeUrl ? (
        <a href={safeUrl} target="_blank" rel="noreferrer" className="link link-hover">
          #{hook.pr.number}
        </a>
      ) : (
        <span>#{hook.pr.number}</span>
      ),
    });
  }
  if (hook.actor) rows.push({ label: "Actor", value: <code className="font-mono">{hook.actor}</code> });
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-base-content/50">{r.label}</dt>
          <dd className="min-w-0 break-words">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Lazy disclosure showing the full raw webhook payload (pretty-printed) with
 *  a copy button. The body only mounts when the disclosure opens (Disclosure
 *  renders children lazily), so the payload is fetched on first open —
 *  payloads are large. */
function HookPayloadDisclosure({ sessionId }: { sessionId: string }) {
  return (
    <Disclosure
      summary={<span className="text-xs font-medium text-base-content/70">Full payload (JSON)</span>}
    >
      <HookPayloadBody sessionId={sessionId} />
    </Disclosure>
  );
}

function HookPayloadBody({ sessionId }: { sessionId: string }) {
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getHookPayload(sessionId)
      .then((p) => !cancelled && setJson(JSON.stringify(p.payload, null, 2)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  function copy() {
    if (json == null) return;
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (error) return <div className="text-xs text-error">No stored payload: {error}</div>;
  if (json === null) return <div className="text-xs text-base-content/50">Loading…</div>;
  return (
    <div className="space-y-1">
      <button type="button" onClick={copy} className="btn btn-xs">
        {copied ? "Copied ✓" : "Copy JSON"}
      </button>
      <pre className="text-[11px] font-mono overflow-x-auto max-h-80 overflow-y-auto bg-base-200 rounded p-2">
        {json}
      </pre>
    </div>
  );
}

function LiveBubble({ turn, streaming }: { turn: LiveTurn; streaming: boolean }) {
  const isUser = turn.role === "user";
  return (
    <div className={`chat ${isUser ? "chat-end" : "chat-start"}`}>
      <div className={`chat-bubble break-words max-w-full ${isUser ? "chat-bubble-primary" : ""}`}>
        {turn.tools.map((t) => (
          <ToolCard key={t.id} name={t.name} call={t.description} pending={t.pending} />
        ))}
        {turn.text ? <MarkdownView source={turn.text} /> : streaming ? "…" : ""}
      </div>
    </div>
  );
}

let turnSeq = 0;

function findResumePoints(messages: ChatMessage[]): Set<number> {
  const set = new Set<number>();
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (!(prev && curr) || prev.role !== "assistant" || curr.role !== "user") {
      continue;
    }
    const dt = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
    if (Number.isFinite(dt) && dt > RESUME_GAP_MS) {
      set.add(i);
    }
  }
  return set;
}

/**
 * Build the chunk / agent-spawn / agent-done callbacks that mutate the
 * live-turn buffer. Extracted so SessionView's onSend stays simple — the
 * cognitive complexity rule complains otherwise.
 */
function makeTurnHandlers(setLiveTurns: React.Dispatch<React.SetStateAction<LiveTurn[]>>) {
  const updateLast = (mutator: (last: LiveTurn) => LiveTurn) => {
    setLiveTurns((t) => {
      const last = t[t.length - 1];
      if (last?.role !== "assistant") {
        return t;
      }
      const next = t.slice(0, -1);
      next.push(mutator(last));
      return next;
    });
  };
  return {
    onChunk: (chunk: string) => updateLast((last) => ({ ...last, text: last.text + chunk })),
    onAgentSpawn: (id: string, description: string) =>
      updateLast((last) => ({
        ...last,
        tools: [...last.tools, { id, name: "agent", description, pending: true }],
      })),
    onAgentDone: (id: string, description: string, agentResult?: string) =>
      updateLast((last) => ({
        ...last,
        tools: last.tools.map((tool) =>
          tool.id === id
            ? { ...tool, pending: false, description: agentResult ?? description }
            : tool,
        ),
      })),
  };
}

// ---------------------------------------------------------------------------
// Bubble state for the live ChatBrowser composer.
// ---------------------------------------------------------------------------

interface Bubble {
  id: number;
  role: "user" | "assistant";
  text: string;
}

let bubbleSeq = 0;

function friendlyName(s: SessionInfo): string {
  if (s.title) {
    return s.title;
  }
  if (s.firstMessage) {
    return s.firstMessage.slice(0, 60);
  }
  if (s.jobName) {
    return s.jobName;
  }
  const when = new Date(s.lastUsedAt);
  if (!Number.isNaN(when.getTime())) {
    return `${s.channel} chat · ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return `${s.channel} chat · ${s.id.slice(0, 8)}`;
}
