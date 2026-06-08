import { MessageSquare, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getApiToken } from "../../api/client";
import {
  type Delivery,
  type DeliverySource,
  getDeliveryPayload,
  listQueue,
  type QueueMessage,
} from "../../api/hooks";
import type { MainPaneProps } from "../App";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/utils";
import { useRoute } from "../router";

// Keep the live feed growing instead of dropping rows; cap high enough to be
// "everything this session" while bounding DOM/memory. (Mirrors web/ui.)
const MAX_ROWS = 1000;

/**
 * v3 Deliveries — real-time incoming-hook log (spec §9).
 *
 * Reuses the proven `/api/hooks/events` SSE pattern from
 * web/ui/sections/DeliveriesSection.tsx (snapshot → per-delivery deltas, with
 * pause/buffer + fade-in on fresh rows) re-styled into the v3 shell, and adds
 * a **jump-to-chat** action: a delivery's `matched[]` job names + its
 * extracted keys are resolved against the live hook queue to find the
 * `threadId`(s) it produced; clicking selects that thread and switches the
 * main pane to chat via the contract's `selectThread`.
 */
export function DeliveriesView(_props: MainPaneProps) {
  const { selectThread } = useRoute();
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Live hook queue, polled alongside the delivery feed, so we can resolve a
  // delivery → the threadId(s) it spawned for jump-to-chat.
  const [queue, setQueue] = useState<QueueMessage[]>([]);

  const seen = useRef<Set<string>>(new Set());
  const pausedRef = useRef(false);
  const pending = useRef<Map<string, Delivery>>(new Map());
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const firstSnapshot = useRef(true);

  const markFresh = (ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    setFreshIds((s) => {
      const n = new Set(s);
      for (const id of ids) {
        n.add(id);
      }
      return n;
    });
    const t = setTimeout(() => {
      setFreshIds((s) => {
        const n = new Set(s);
        for (const id of ids) {
          n.delete(id);
        }
        return n;
      });
      timers.current.delete(t);
    }, 1000);
    timers.current.add(t);
  };

  const countNewPending = () => {
    let n = 0;
    for (const id of pending.current.keys()) {
      if (!seen.current.has(id)) {
        n += 1;
      }
    }
    return n;
  };

  const handleDelta = (d: Delivery) => {
    if (pausedRef.current) {
      pending.current.set(d.id, d);
      setPendingCount(countNewPending());
      return;
    }
    const isNew = !seen.current.has(d.id);
    seen.current.add(d.id);
    setDeliveries((prev) => upsert(prev ?? [], d));
    if (isNew) {
      markFresh([d.id]);
    }
  };

  const resume = () => {
    pausedRef.current = false;
    setPaused(false);
    const buffered = [...pending.current.values()].sort((a, b) => a.receivedAt - b.receivedAt);
    pending.current.clear();
    setPendingCount(0);
    if (buffered.length === 0) {
      return;
    }
    const newIds = buffered.filter((d) => !seen.current.has(d.id)).map((d) => d.id);
    setDeliveries((prev) => {
      let next = prev ?? [];
      for (const d of buffered) {
        next = upsert(next, d);
      }
      return next;
    });
    for (const d of buffered) {
      seen.current.add(d.id);
    }
    markFresh(newIds);
  };

  const pause = () => {
    pausedRef.current = true;
    setPaused(true);
  };

  // Delivery feed (SSE).
  useEffect(() => {
    const token = getApiToken();
    const url = `/api/hooks/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    const localTimers = timers.current;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as {
          type?: string;
          deliveries?: unknown;
          delivery?: unknown;
        };
        if (ev.type === "snapshot" && Array.isArray(ev.deliveries)) {
          const list = ev.deliveries as Delivery[];
          if (firstSnapshot.current) {
            firstSnapshot.current = false;
            for (const d of list) {
              seen.current.add(d.id);
            }
            setDeliveries(list);
          } else {
            for (const d of list) {
              handleDelta(d);
            }
          }
        } else if (ev.type === "delivery" && ev.delivery) {
          handleDelta(ev.delivery as Delivery);
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      es.close();
      for (const t of localTimers) {
        clearTimeout(t);
      }
      localTimers.clear();
    };
    // SSE lifetime is component-scoped; helpers are ref/setter-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleDelta]);

  // Live hook queue (SSE) — fuels threadId resolution for jump-to-chat. We
  // bootstrap with a snapshot fetch and keep it warm via the queue events.
  useEffect(() => {
    let cancelled = false;
    listQueue()
      .then((r) => !cancelled && setQueue(r.messages))
      .catch(() => {});
    const token = getApiToken();
    const url = `/api/hooks/queue/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as { type?: string; messages?: unknown };
        if (ev.type === "snapshot" && Array.isArray(ev.messages)) {
          setQueue(ev.messages as QueueMessage[]);
        }
      } catch {
        // ignore
      }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const statusLabel = connected ? (paused ? "paused" : "live") : "offline";
  const statusColor = paused ? "text-warning" : connected ? "text-success" : "text-base-content/50";
  const dotColor = paused
    ? "bg-warning"
    : connected
      ? "bg-success animate-pulse"
      : "bg-base-content/30";

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <header className="shrink-0 px-4 py-3 border-b border-base-300 flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Webhook Deliveries</h1>
        <span
          className={cn("inline-flex items-center gap-1 text-xs", statusColor)}
          title={
            paused
              ? "Paused — new deliveries are buffered"
              : connected
                ? "Live — streaming new deliveries"
                : "Reconnecting…"
          }
        >
          <span className={cn("inline-block h-2 w-2 rounded-full", dotColor)} />
          {statusLabel}
        </span>
        <Button
          variant={paused && pendingCount > 0 ? "default" : "outline"}
          size="sm"
          className="ml-auto gap-1"
          onClick={() => (paused ? resume() : pause())}
          title={paused ? "Resume the live feed" : "Pause the live feed"}
        >
          {paused ? (
            <>
              <Play className="size-3.5" aria-hidden />
              Resume
              {pendingCount > 0 && (
                <span className="badge badge-xs badge-neutral">{pendingCount} new</span>
              )}
            </>
          ) : (
            <>
              <Pause className="size-3.5" aria-hidden />
              Pause
            </>
          )}
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {deliveries === null ? (
          <div className="text-sm text-base-content/60">Connecting to the live stream…</div>
        ) : deliveries.length === 0 ? (
          <div className="text-sm text-base-content/60">
            No deliveries yet — they'll appear here the moment a webhook arrives.
          </div>
        ) : (
          <DeliveryTable
            deliveries={deliveries}
            queue={queue}
            expanded={expanded}
            freshIds={freshIds}
            onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
            onJump={selectThread}
          />
        )}
      </div>
    </div>
  );
}

function upsert(list: Delivery[], d: Delivery): Delivery[] {
  const next = [d, ...list.filter((x) => x.id !== d.id)];
  next.sort((a, b) => b.receivedAt - a.receivedAt);
  return next.slice(0, MAX_ROWS);
}

/**
 * Resolve the chat threads a delivery produced.
 *
 * A thread id is `<jobName>:hook:<scope>`. The delivery carries the matched
 * job names but not the scope, so we look the threads up in the live hook
 * queue: any queue row whose `jobName` is one this delivery matched AND which
 * shares the delivery's identity (PR number / repo, or an extracted key) is a
 * thread this delivery is part of. De-duped by threadId, newest-first.
 */
function resolveThreads(d: Delivery, queue: QueueMessage[]): QueueMessage[] {
  const matched = new Set(d.matched ?? []);
  if (matched.size === 0) {
    return [];
  }
  const pk = d.pk ?? undefined;
  const key1 = d.keys?.key1 ?? undefined;
  const key2 = d.keys?.key2 ?? undefined;

  const byThread = new Map<string, QueueMessage>();
  for (const m of queue) {
    if (!matched.has(m.jobName)) {
      continue;
    }
    // Identity overlap: the queue row's PR / extracted keys should line up
    // with this delivery. GitHub rows carry prNumber; provider rows carry
    // keys. If the delivery has no discriminator at all, fall back to
    // job-name match alone.
    const sameKeys =
      (key1 != null && (m.keys?.key1 === key1 || m.scope.includes(key1))) ||
      (key2 != null && (m.keys?.key2 === key2 || m.scope.includes(key2))) ||
      (pk != null && (m.prNumber == null ? m.scope.includes(pk) : String(m.prNumber) === pk));
    const hasDiscriminator = key1 != null || key2 != null || pk != null;
    if (hasDiscriminator && !sameKeys) {
      continue;
    }
    const prev = byThread.get(m.threadId);
    if (!prev || m.enqueuedAt > prev.enqueuedAt) {
      byThread.set(m.threadId, m);
    }
  }
  return [...byThread.values()].sort((a, b) => b.enqueuedAt - a.enqueuedAt);
}

function DeliveryTable({
  deliveries,
  queue,
  expanded,
  freshIds,
  onToggle,
  onJump,
}: {
  deliveries: Delivery[];
  queue: QueueMessage[];
  expanded: string | null;
  freshIds: Set<string>;
  onToggle: (id: string) => void;
  onJump: (threadId: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-base-300 bg-base-100">
      <table className="table table-sm">
        <thead>
          <tr className="text-xs uppercase text-base-content/60">
            <th>Source</th>
            <th>PK</th>
            <th>Type</th>
            <th>Key 1</th>
            <th>Key 2</th>
            <th>Routines</th>
            <th>Key fields</th>
            <th>Chat</th>
            <th className="text-right">Time</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <DeliveryRow
              key={d.id}
              d={d}
              threads={resolveThreads(d, queue)}
              open={expanded === d.id}
              fresh={freshIds.has(d.id)}
              onToggle={() => onToggle(d.id)}
              onJump={onJump}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeliveryRow({
  d,
  threads,
  open,
  fresh,
  onToggle,
  onJump,
}: {
  d: Delivery;
  threads: QueueMessage[];
  open: boolean;
  fresh: boolean;
  onToggle: () => void;
  onJump: (threadId: string) => void;
}) {
  const fields = d.fields ?? [];
  const routines = d.routines ?? [];
  return (
    <>
      <tr
        className={cn("cursor-pointer hover:bg-base-200", fresh && "row-enter")}
        onClick={onToggle}
        aria-expanded={open}
      >
        <td>
          <SourceBadge source={d.source ?? sourceFromEvent(d.event)} />
        </td>
        <td className="font-mono text-xs whitespace-nowrap font-semibold">
          {d.pk ? <span>{d.pk}</span> : <span className="text-base-content/30">—</span>}
        </td>
        <td className="font-mono text-xs whitespace-nowrap">{d.event}</td>
        <KeyCell label={d.keys?.key1Label} value={d.keys?.key1} />
        <KeyCell label={d.keys?.key2Label} value={d.keys?.key2} />
        <td className="min-w-40">
          {routines.length === 0 ? (
            <span className="text-base-content/40 text-xs">—</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {routines.map((r) => {
                const ignored = r.outcome === "skip" && (r.reason ?? "").startsWith("ignore");
                const verb = r.outcome === "trigger" ? "▶ " : ignored ? "ignore " : "skip ";
                const badge =
                  r.outcome === "trigger"
                    ? "badge-success"
                    : ignored
                      ? "badge-info"
                      : "badge-warning";
                return (
                  <span
                    key={`${r.job}-${r.outcome}`}
                    className={cn("badge badge-xs", badge)}
                    title={r.reason ?? (r.outcome === "trigger" ? "will trigger" : undefined)}
                  >
                    {verb}
                    {r.job}
                  </span>
                );
              })}
            </div>
          )}
        </td>
        <td className="text-xs text-base-content/80 max-w-xs">
          {fields.length === 0 ? (
            <span className="text-base-content/40">—</span>
          ) : (
            <span className="line-clamp-2">
              {fields.map((f, i) => (
                <span key={f.label}>
                  {i > 0 && <span className="text-base-content/30"> · </span>}
                  <span className="text-base-content/50">{f.label}=</span>
                  <span className="font-medium">{f.value}</span>
                </span>
              ))}
            </span>
          )}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <JumpToChat threads={threads} onJump={onJump} />
        </td>
        <td
          className="text-right whitespace-nowrap text-xs"
          title={new Date(d.receivedAt).toLocaleString()}
        >
          {relativeTime(d.receivedAt)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} className="bg-base-200/40">
            <DeliveryDetail d={d} threads={threads} onJump={onJump} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Jump-to-chat control: nothing matched → muted dash; one thread → a direct
 *  button; many → a tiny dropdown of the threads this delivery spawned. */
function JumpToChat({
  threads,
  onJump,
}: {
  threads: QueueMessage[];
  onJump: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (threads.length === 0) {
    return <span className="text-base-content/30 text-xs">—</span>;
  }
  if (threads.length === 1) {
    const t = threads[0];
    if (!t) {
      return null;
    }
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-primary"
        onClick={() => onJump(t.threadId)}
        title={`Open chat for ${t.jobName} (${t.scope})`}
      >
        <MessageSquare className="size-3.5" aria-hidden />
        Open
      </Button>
    );
  }
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-primary"
        onClick={() => setOpen((v) => !v)}
        title="Open one of this delivery's chats"
      >
        <MessageSquare className="size-3.5" aria-hidden />
        {threads.length} chats
      </Button>
      {open && (
        <ul className="absolute right-0 z-10 mt-1 min-w-48 rounded-md border border-base-300 bg-base-100 py-1 shadow-lg">
          {threads.map((t) => (
            <li key={t.threadId}>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-xs hover:bg-base-200"
                onClick={() => {
                  setOpen(false);
                  onJump(t.threadId);
                }}
              >
                <span className="font-mono font-medium">{t.jobName}</span>
                <span className="ml-1 text-base-content/50">{t.scope}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeliveryDetail({
  d,
  threads,
  onJump,
}: {
  d: Delivery;
  threads: QueueMessage[];
  onJump: (threadId: string) => void;
}) {
  const fields = d.fields ?? [];
  const routines = d.routines ?? [];
  return (
    <div className="space-y-3 py-2">
      {d.summary && <div className="text-xs text-base-content/70">{d.summary}</div>}

      {fields.length > 0 && (
        <div>
          <div className="text-[11px] uppercase text-base-content/50 mb-1">Extracted fields</div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
            {fields.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-base-content/50">{f.label}</dt>
                <dd className="font-mono break-all">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {routines.length > 0 && (
        <div>
          <div className="text-[11px] uppercase text-base-content/50 mb-1">Routine outcomes</div>
          <ul className="text-xs space-y-0.5">
            {routines.map((r) => (
              <li key={`${r.job}-${r.outcome}`} className="flex gap-2">
                <span
                  className={cn(
                    "badge badge-xs",
                    r.outcome === "trigger" ? "badge-success" : "badge-warning",
                  )}
                >
                  {r.outcome}
                </span>
                <span className="font-medium">{r.job}</span>
                {r.reason && <span className="text-base-content/60">— {r.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {threads.length > 0 && (
        <div>
          <div className="text-[11px] uppercase text-base-content/50 mb-1">Chats</div>
          <div className="flex flex-wrap gap-2">
            {threads.map((t) => (
              <Button
                key={t.threadId}
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => onJump(t.threadId)}
              >
                <MessageSquare className="size-3.5" aria-hidden />
                <span className="font-mono">{t.jobName}</span>
                <span className="text-base-content/50">{t.scope}</span>
              </Button>
            ))}
          </div>
        </div>
      )}

      <DeliveryPayloadBody id={d.id} />
    </div>
  );
}

/** Lazily fetches + prettifies the full payload (omitted from the list/SSE
 *  responses to keep them light). */
function DeliveryPayloadBody({ id }: { id: string }) {
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDeliveryPayload(id)
      .then((p) => !cancelled && setJson(JSON.stringify(p.payload, null, 2)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  function copy() {
    if (json == null) {
      return;
    }
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] uppercase text-base-content/50">Full payload</span>
        {json != null && (
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={copy}>
            {copied ? "Copied ✓" : "Copy JSON"}
          </Button>
        )}
      </div>
      {error ? (
        <div className="text-xs text-error">No stored payload: {error}</div>
      ) : json === null ? (
        <div className="text-xs text-base-content/50">Loading…</div>
      ) : (
        <pre className="text-[11px] font-mono overflow-x-auto max-h-96 overflow-y-auto bg-base-100 rounded p-2 border border-base-300">
          {json}
        </pre>
      )}
    </div>
  );
}

function KeyCell({ label, value }: { label: string | undefined; value: string | undefined }) {
  if (!value) {
    return <td className="text-base-content/30 text-xs">—</td>;
  }
  return (
    <td className="text-xs whitespace-nowrap" title={label ? `${label}: ${value}` : value}>
      {label && <span className="text-base-content/40">{label}: </span>}
      <span className="font-mono font-medium">{value}</span>
    </td>
  );
}

function SourceBadge({ source }: { source: DeliverySource }) {
  const cls =
    source === "github"
      ? "badge-neutral"
      : source === "sentry"
        ? "badge-secondary"
        : "badge-primary";
  return <span className={cn("badge badge-sm", cls)}>{source}</span>;
}

function sourceFromEvent(event: string): DeliverySource {
  if (event.startsWith("sentry:")) {
    return "sentry";
  }
  if (event.startsWith("datadog:")) {
    return "datadog";
  }
  return "github";
}

/** Compact relative time ("3m", "2h", "5d"); full timestamp lives on `title`. */
function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (Number.isNaN(s)) {
    return "—";
  }
  if (s < 60) {
    return `${Math.max(s, 0)}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h`;
  }
  if (s < 604800) {
    return `${Math.floor(s / 86400)}d`;
  }
  return new Date(ms).toLocaleDateString();
}
