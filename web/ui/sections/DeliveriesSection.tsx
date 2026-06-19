import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getApiToken } from "../../api/client";
import { type Delivery, type DeliverySource, getDeliveryPayload } from "../../api/hooks";
import { Card } from "../components/Card";
import { Empty, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";

// Let the live feed grow rather than dropping old rows from the bottom; cap
// high enough to be effectively "keep everything this session" while bounding
// memory/DOM.
const MAX_ROWS = 1000;

/**
 * Real-time table of incoming webhook deliveries (GitHub / Sentry / Datadog).
 * Fed by the `/api/hooks/events` SSE stream: an initial snapshot then a delta
 * per delivery as it's recorded, matched, or skip-annotated. Each row expands
 * to show every extracted field and the full prettified payload.
 */
export function DeliveriesSection() {
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Ids that just streamed in (delta events, not the initial snapshot) get the
  // fade-in highlight for ~1s. `seenRef` tracks every id we've shown so a delivery
  // re-emitted after its evaluation lands doesn't re-animate.
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  // Play/pause: while paused, incoming deltas are buffered (not rendered) and
  // we surface how many *new* ones are waiting. Resume flushes them in.
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const seenRef = useRef<Set<string>>(new Set());
  const pausedRef = useRef(false); // synchronous mirror for the SSE closure
  const pendingRef = useRef<Map<string, Delivery>>(new Map());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const firstSnapshotRef = useRef(true);

  // Stable helpers — they only touch refs + state setters, so the SSE closure
  // (bound once) always sees current behavior.
  const markFresh = (ids: string[]) => {
    if (ids.length === 0) return;
    setFreshIds((s) => {
      const n = new Set(s);
      for (const id of ids) n.add(id);
      return n;
    });
    const t = setTimeout(() => {
      setFreshIds((s) => {
        const n = new Set(s);
        for (const id of ids) n.delete(id);
        return n;
      });
      timersRef.current.delete(t);
    }, 1000);
    timersRef.current.add(t);
  };

  const countNewPending = () => {
    let n = 0;
    for (const id of pendingRef.current.keys()) {
      if (!seenRef.current.has(id)) n += 1;
    }
    return n;
  };

  const handleDelta = (d: Delivery) => {
    if (pausedRef.current) {
      pendingRef.current.set(d.id, d);
      setPendingCount(countNewPending());
      return;
    }
    const isNew = !seenRef.current.has(d.id);
    seenRef.current.add(d.id);
    setDeliveries((prev) => upsert(prev ?? [], d));
    if (isNew) markFresh([d.id]);
  };

  const resume = () => {
    pausedRef.current = false;
    setPaused(false);
    const buffered = [...pendingRef.current.values()].sort((a, b) => a.receivedAt - b.receivedAt);
    pendingRef.current.clear();
    setPendingCount(0);
    if (buffered.length === 0) return;
    const newIds = buffered.filter((d) => !seenRef.current.has(d.id)).map((d) => d.id);
    setDeliveries((prev) => {
      let next = prev ?? [];
      for (const d of buffered) next = upsert(next, d);
      return next;
    });
    for (const d of buffered) seenRef.current.add(d.id);
    markFresh(newIds);
  };

  const pause = () => {
    pausedRef.current = true;
    setPaused(true);
  };

  useEffect(() => {
    const token = getApiToken();
    const url = `/api/hooks/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    const localTimers = timersRef.current;
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
          if (firstSnapshotRef.current) {
            // Initial backlog — show it without animating or buffering.
            firstSnapshotRef.current = false;
            for (const d of list) seenRef.current.add(d.id);
            setDeliveries(list);
          } else {
            // A reconnect re-snapshot — fold each entry through the delta path
            // so pause buffering + animation still apply.
            for (const d of list) handleDelta(d);
          }
        } else if (ev.type === "delivery" && ev.delivery) {
          handleDelta(ev.delivery as Delivery);
        }
        // `ping` heartbeats are ignored.
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      es.close();
      for (const t of localTimers) clearTimeout(t);
      localTimers.clear();
    };
    // SSE lifetime is component-scoped; helpers are ref/setter-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, []);

  const statusLabel = connected ? (paused ? "paused" : "live") : "offline";
  const statusColor = paused ? "text-warning" : connected ? "text-success" : "text-base-content/50";
  const dotColor = paused
    ? "bg-warning"
    : connected
      ? "bg-success animate-pulse"
      : "bg-base-content/30";

  return (
    <>
      <PageHeader title="Webhook Deliveries" crumbs={[{ label: "Deliveries" }]} />
      <Card
        title={
          <span className="flex items-center gap-2">
            Incoming hooks
            <span
              className={`inline-flex items-center gap-1 text-xs font-normal ${statusColor}`}
              title={
                paused
                  ? "Paused — new deliveries are buffered"
                  : connected
                    ? "Live — streaming new deliveries"
                    : "Reconnecting…"
              }
            >
              <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
              {statusLabel}
            </span>
          </span>
        }
        actions={
          <button
            type="button"
            className={`btn btn-xs gap-1 ${paused && pendingCount > 0 ? "btn-warning" : ""}`}
            onClick={() => (paused ? resume() : pause())}
            title={paused ? "Resume the live feed" : "Pause the live feed"}
          >
            {paused ? (
              <>
                <Play size={12} aria-hidden />
                Resume
                {pendingCount > 0 && (
                  <span className="badge badge-xs badge-neutral">{pendingCount} new</span>
                )}
              </>
            ) : (
              <>
                <Pause size={12} aria-hidden />
                Pause
              </>
            )}
          </button>
        }
      >
        {deliveries === null ? (
          <Loader label="Connecting to the live stream…" />
        ) : deliveries.length === 0 ? (
          <Empty>No deliveries yet — they'll appear here the moment a webhook arrives.</Empty>
        ) : (
          <DeliveryTable
            deliveries={deliveries}
            expanded={expanded}
            freshIds={freshIds}
            onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
          />
        )}
      </Card>
    </>
  );
}

function upsert(list: Delivery[], d: Delivery): Delivery[] {
  const next = [d, ...list.filter((x) => x.id !== d.id)];
  next.sort((a, b) => b.receivedAt - a.receivedAt);
  return next.slice(0, MAX_ROWS);
}

function DeliveryTable({
  deliveries,
  expanded,
  freshIds,
  onToggle,
}: {
  deliveries: Delivery[];
  expanded: string | null;
  freshIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
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
            <th className="text-right">Time</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <DeliveryRow
              key={d.id}
              d={d}
              open={expanded === d.id}
              fresh={freshIds.has(d.id)}
              onToggle={() => onToggle(d.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeliveryRow({
  d,
  open,
  fresh,
  onToggle,
}: {
  d: Delivery;
  open: boolean;
  fresh: boolean;
  onToggle: () => void;
}) {
  const fields = d.fields ?? [];
  const routines = d.routines ?? [];
  return (
    <>
      <tr
        className={`cursor-pointer hover:bg-base-200 ${fresh ? "row-enter" : ""}`}
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
                const cls =
                  r.outcome === "trigger"
                    ? "badge-success"
                    : ignored
                      ? "badge-info"
                      : "badge-warning";
                return (
                  <span
                    key={`${r.job}-${r.outcome}`}
                    className={`badge badge-xs ${cls}`}
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
        <td
          className="text-right whitespace-nowrap text-xs"
          title={new Date(d.receivedAt).toLocaleString()}
        >
          {relativeTime(d.receivedAt)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="bg-base-200/40">
            <DeliveryDetail d={d} />
          </td>
        </tr>
      )}
    </>
  );
}

function DeliveryDetail({ d }: { d: Delivery }) {
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
                  className={`badge badge-xs ${r.outcome === "trigger" ? "badge-success" : "badge-warning"}`}
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
          <button type="button" onClick={copy} className="btn btn-xs">
            {copied ? "Copied ✓" : "Copy JSON"}
          </button>
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

/** A key column cell. Headers are generic (Key 1 / Key 2) but values are
 *  provider-specific, so we prefix the value with its label (muted) to keep
 *  mixed-provider rows self-describing. */
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
  return <span className={`badge badge-sm ${cls}`}>{source}</span>;
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
