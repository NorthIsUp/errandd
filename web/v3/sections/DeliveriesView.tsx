import { MessageSquare, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type Delivery,
  type DeliverySource,
  getDeliveryPayload,
  type QueueMessage,
} from "../../api/hooks";
import type { MainPaneProps } from "../App";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/utils";
import { useDeliveryStream } from "../hooks/useDeliveryStream";
import { deliveryIdentityKey, queueIdentityKey } from "../lib/deliveryKey";
import { useRoute } from "../router";

/**
 * v3 Deliveries — real-time incoming-hook log (spec §9).
 *
 * Purely presentational: the SSE feed, pause/buffer, fresh-row window, and the
 * live hook queue all live in {@link useDeliveryStream}. This view renders that
 * state and adds a **jump-to-chat** action: a delivery's `matched[]` job names +
 * its extracted keys are resolved against the live hook queue to find the
 * `threadId`(s) it produced; clicking selects that thread and switches the
 * main pane to chat via the contract's `selectThread`.
 */
export function DeliveriesView(_props: MainPaneProps) {
  const { selectThread } = useRoute();
  const { deliveries, queue, connected, paused, pendingCount, freshIds, pause, resume } =
    useDeliveryStream();
  const [expanded, setExpanded] = useState<string | null>(null);

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

/**
 * Resolve the chat threads a delivery produced.
 *
 * A thread id is `<jobName>:hook:<scope>`. The delivery carries the matched
 * job names but not the scope, so we look the threads up in the live hook
 * queue: any queue row whose `jobName` is one this delivery matched AND whose
 * canonical identity key (derived from the structured PR number / extracted
 * keys — see lib/deliveryKey) equals the delivery's is a thread this delivery
 * is part of. Equality on the structured key replaces the old `scope.includes`
 * substring heuristic, which risked matching the wrong thread. If the delivery
 * carries no discriminator at all, we fall back to job-name match alone.
 * De-duped by threadId, newest-first.
 */
function resolveThreads(d: Delivery, queue: QueueMessage[]): QueueMessage[] {
  const matched = new Set(d.matched ?? []);
  if (matched.size === 0) {
    return [];
  }
  const wantKey = deliveryIdentityKey(d);

  const byThread = new Map<string, QueueMessage>();
  for (const m of queue) {
    if (!matched.has(m.jobName)) {
      continue;
    }
    // Identity match: equal canonical keys. When the delivery has no
    // discriminator (wantKey === null), fall back to job-name match alone.
    if (wantKey != null && queueIdentityKey(m) !== wantKey) {
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
