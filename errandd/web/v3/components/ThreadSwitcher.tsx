import { Bell, Bug, CalendarClock, GitPullRequest, Search, Ticket, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { searchThreads, type ThreadEntry } from "../lib/threadCatalog";

const ICONS = { github: GitPullRequest, sentry: Bug, datadog: Bell, linear: Ticket, routines: CalendarClock };
const STATUS = { pending: "Queued", running: "Working", failed: "Failed", done: "Done" };

export function ThreadSwitcher({ threads, loading, activeThreadId, onSelect, onClose }: {
  threads: ThreadEntry[];
  loading: boolean;
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchThreads(threads, query), [threads, query]);
  const visible = matches.slice(0, 60);
  useEffect(() => {
    const element = dialogRef.current;
    element?.showModal();
    inputRef.current?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => {
    const element = dialogRef.current;
    const backdrop = (event: MouseEvent) => { if (event.target === element) onClose(); };
    element?.addEventListener("click", backdrop);
    return () => element?.removeEventListener("click", backdrop);
  }, [onClose]);
  const select = (id: string) => { onSelect(id); onClose(); };
  const move = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>("button[data-thread-result]") ?? [])];
    if (event.key === "Enter") {
      if (event.target === inputRef.current && buttons[0]) { event.preventDefault(); buttons[0].click(); }
      return;
    }
    event.preventDefault();
    if (!buttons.length) return;
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    buttons[index < 0 ? (direction > 0 ? 0 : buttons.length - 1) : (index + direction + buttons.length) % buttons.length]?.focus();
  };
  return (
    <dialog ref={dialogRef} className="v3-thread-switcher" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onClose(); }}
      >
      <div>
        <h2 className="sr-only" id={titleId}>Jump to a thread</h2>
        <div className="v3-switcher-search"><Search size={18} aria-hidden="true" />
          <input ref={inputRef} type="search" onKeyDown={move} value={query} onChange={event => setQuery(event.target.value)} aria-label="Find a thread" placeholder="Thread, PR number, job, or author…" />
          <button type="button" aria-label="Close thread switcher" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="v3-switcher-label">{query.trim() ? "Matching threads" : "Recent threads"}</div>
        <div ref={resultsRef} className="v3-switcher-results" aria-busy={loading}>
          {visible.map(entry => {
            const Icon = ICONS[entry.source];
            return <button key={entry.threadId} type="button" onKeyDown={move} data-thread-result onClick={() => select(entry.threadId)} aria-current={entry.threadId === activeThreadId ? "page" : undefined}>
              <Icon size={16} aria-hidden="true" /><span className="v3-switcher-entry"><span>{entry.title}</span><small>{entry.subtitle}</small></span>
              <span className="v3-switcher-status" data-status={entry.status ?? "unknown"}>{entry.status ? STATUS[entry.status] : "Conversation"}</span>
            </button>;
          })}
          {!visible.length && <p role="status">{loading ? "Loading threads…" : query.trim() ? "No matching threads." : "No conversations yet."}</p>}
        </div>
        <div className="v3-switcher-footer"><span>↑ ↓ to move · Enter to open · Esc to close</span><span aria-live="polite">{matches.length > 60 ? `60 of ${matches.length}` : matches.length} threads</span></div>
      </div>
    </dialog>
  );
}
