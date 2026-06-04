import { useEffect, useMemo, useState } from "react";
import { getApiToken } from "../../api/client";
import type { QueueMessage } from "../../api/hooks";
import { listSessions, type SessionInfo } from "../../api/sessions";
import { Card } from "../components/Card";
import { Disclosure } from "../components/Disclosure";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { useRoute } from "../router";
import { useAsync } from "../useAsync";

/**
 * PR-centric view of hook activity. Each PR groups its routines (pr-comments,
 * pr-review, …); each routine shows its resumed Claude chat session plus the
 * LIVE durable-queue state for that PR — what's running, what's queued behind
 * it, and what's deferred/retrying — fed by the /api/hooks/queue SSE.
 */
export function PrsSection() {
  const { goto } = useRoute();
  const sessions = useAsync<SessionInfo[]>(() => listSessions(true));
  const [queue, setQueue] = useState<QueueMessage[] | null>(null);
  const [connected, setConnected] = useState(false);
  // Ticks every second so "deferred" flips to "queued" live when a backoff
  // elapses (and keeps Date.now() out of render).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const token = getApiToken();
    const url = `/api/hooks/queue/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    let lastReload = 0;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as { type?: string; messages?: unknown };
        if (ev.type === "snapshot" && Array.isArray(ev.messages)) {
          setQueue(ev.messages as QueueMessage[]);
          // New hook activity may have spawned new chat sessions — refresh, but
          // at most every few seconds so a busy drain doesn't hammer the API.
          const now = Date.now();
          if (now - lastReload > 4000) {
            lastReload = now;
            sessions.reload();
          }
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [sessions.reload]);

  const groups = useMemo(
    () => buildPrGroups(sessions.data ?? [], queue ?? []),
    [sessions.data, queue],
  );

  return (
    <>
      <PageHeader title="Pull Requests" crumbs={[{ label: "PRs" }]} />
      <Card
        title={
          <span className="flex items-center gap-2">
            Active PRs
            <span
              className={`inline-flex items-center gap-1 text-xs font-normal ${connected ? "text-success" : "text-base-content/50"}`}
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-success animate-pulse" : "bg-base-content/30"}`}
              />
              {connected ? "live" : "offline"}
            </span>
          </span>
        }
      >
        {sessions.loading && queue === null ? (
          <Loader label="Loading PR activity…" />
        ) : sessions.error ? (
          <ErrorBanner error={sessions.error} />
        ) : groups.length === 0 ? (
          <Empty>No PR hook activity yet — comment on a watched PR and it'll appear here.</Empty>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <PrCard key={g.key} group={g} now={now} onOpenChat={(id) => goto("chat", [id])} />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

interface RoutineGroup {
  jobName: string;
  session: SessionInfo | null;
  msgs: QueueMessage[];
}
interface PrGroup {
  key: string;
  label: string;
  prUrl: string | null;
  routines: RoutineGroup[];
  lastActivity: number;
}

function buildPrGroups(sessions: SessionInfo[], queue: QueueMessage[]): PrGroup[] {
  const groups = new Map<string, PrGroup>();

  const ensure = (key: string, label: string, prUrl: string | null): PrGroup => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, prUrl, routines: [], lastActivity: 0 };
      groups.set(key, g);
    }
    return g;
  };
  const ensureRoutine = (g: PrGroup, jobName: string): RoutineGroup => {
    let r = g.routines.find((x) => x.jobName === jobName);
    if (!r) {
      r = { jobName, session: null, msgs: [] };
      g.routines.push(r);
    }
    return r;
  };

  // Sessions first — they carry the chat link + history.
  for (const s of sessions) {
    if (s.trigger?.kind !== "hook" || !s.trigger.pr) {
      continue;
    }
    const repo = s.trigger.repo ?? "?";
    const key = `${repo}#${s.trigger.pr.number}`;
    const g = ensure(key, key, s.trigger.pr.url ?? null);
    const r = ensureRoutine(g, s.jobName ?? s.agent ?? "hook");
    const at = new Date(s.lastUsedAt).getTime();
    if (!r.session || at > new Date(r.session.lastUsedAt).getTime()) {
      r.session = s;
    }
    g.lastActivity = Math.max(g.lastActivity, at);
  }

  // Queue overlay — live pending/running/deferred for each PR routine.
  for (const m of queue) {
    if (m.prNumber == null) {
      continue; // non-PR (sentry/datadog) — omit from PR view
    }
    const repo = m.prRepo ?? "?";
    const key = `${repo}#${m.prNumber}`;
    const g = ensure(key, key, null);
    const r = ensureRoutine(g, m.jobName);
    r.msgs.push(m);
    g.lastActivity = Math.max(g.lastActivity, m.enqueuedAt, m.updatedAt);
  }

  for (const g of groups.values()) {
    g.routines.sort((a, b) => a.jobName.localeCompare(b.jobName));
  }
  return [...groups.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

function PrCard({
  group,
  now,
  onOpenChat,
}: {
  group: PrGroup;
  now: number;
  onOpenChat: (id: string) => void;
}) {
  return (
    <div className="border border-base-300 rounded-box p-2 sm:p-3 bg-base-100">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-sm font-semibold">{group.label}</span>
        {group.prUrl && (
          <a
            href={group.prUrl}
            target="_blank"
            rel="noreferrer"
            className="link link-hover text-xs text-base-content/60"
          >
            open on GitHub ↗
          </a>
        )}
      </div>
      <div className="space-y-1.5">
        {group.routines.map((r) => (
          <RoutineRow key={r.jobName} routine={r} now={now} onOpenChat={onOpenChat} />
        ))}
      </div>
    </div>
  );
}

function RoutineRow({
  routine,
  now,
  onOpenChat,
}: {
  routine: RoutineGroup;
  now: number;
  onOpenChat: (id: string) => void;
}) {
  const session = routine.session;
  const running = routine.msgs.filter((m) => m.status === "running");
  const pendingReady = routine.msgs.filter((m) => m.status === "pending" && m.notBefore <= now);
  const deferred = routine.msgs.filter((m) => m.status === "pending" && m.notBefore > now);
  const lastFailed = routine.msgs.find((m) => m.status === "failed");

  return (
    <div className="rounded bg-base-200/40">
      <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
        <span className="font-medium">{routine.jobName}</span>
        {running.length > 0 && (
          <span className="badge badge-xs badge-info gap-1">
            <span className="loading loading-spinner loading-xs" />
            running
          </span>
        )}
        {pendingReady.length > 0 && (
          <span className="badge badge-xs badge-warning">{pendingReady.length} queued</span>
        )}
        {deferred.length > 0 && (
          <span
            className="badge badge-xs badge-ghost"
            title={`retrying after backoff / rate-limit at ${new Date(
              Math.min(...deferred.map((m) => m.notBefore)),
            ).toLocaleTimeString()}`}
          >
            {deferred.length} deferred
          </span>
        )}
        {lastFailed && (
          <span className="badge badge-xs badge-error" title={lastFailed.error ?? "failed"}>
            failed
          </span>
        )}
        <div className="flex-1" />
        {session ? (
          <button type="button" className="btn btn-xs" onClick={() => onOpenChat(session.id)}>
            chat ({session.turnCount}) ↗
          </button>
        ) : (
          <span className="text-xs text-base-content/40">no session yet</span>
        )}
      </div>
      {routine.msgs.length > 0 && (
        <div className="px-2 pb-1.5">
          <Disclosure
            summary={
              <span className="text-xs text-base-content/60">
                queue ({routine.msgs.length} message{routine.msgs.length === 1 ? "" : "s"})
              </span>
            }
          >
            <ul className="text-xs space-y-0.5">
              {[...routine.msgs]
                .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
                .map((m) => (
                  <li key={m.id} className="flex items-center gap-2">
                    <QueueStatusBadge m={m} now={now} />
                    <span className="font-mono">{m.event}</span>
                    {m.keys && (m.keys.key1 || m.keys.key2) && (
                      <span className="text-base-content/60">
                        {[m.keys.key1, m.keys.key2].filter(Boolean).join(" · ")}
                      </span>
                    )}
                    {m.attempts > 0 && (
                      <span className="text-base-content/50">· attempt {m.attempts + 1}</span>
                    )}
                    {m.error && <span className="text-base-content/50 truncate">· {m.error}</span>}
                    <span className="ml-auto text-base-content/40">
                      {new Date(m.enqueuedAt).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

function QueueStatusBadge({ m, now }: { m: QueueMessage; now: number }) {
  if (m.status === "running") {
    return <span className="badge badge-xs badge-info">running</span>;
  }
  if (m.status === "done") {
    // Show the AGENT outcome, not just "done": ok = addressed work,
    // pass = ran and chose to no-op ([skip]), error = non-zero exit.
    if (m.outcome === "pass") {
      return (
        <span className="badge badge-xs badge-neutral" title="agent ran and chose to no-op">
          pass
        </span>
      );
    }
    if (m.outcome === "error") {
      return <span className="badge badge-xs badge-error">error</span>;
    }
    return <span className="badge badge-xs badge-success">{m.outcome ?? "done"}</span>;
  }
  if (m.status === "failed") {
    return <span className="badge badge-xs badge-error">failed</span>;
  }
  if (m.notBefore > now) {
    return <span className="badge badge-xs badge-ghost">deferred</span>;
  }
  return <span className="badge badge-xs badge-warning">queued</span>;
}
