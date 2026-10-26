import { randomUUID } from "node:crypto";
import { getHookQueue } from "../../hookQueue";
import { clampInt, json } from "../http";
import type { ThreadMessagesResponse } from "../services/threadParts";
import type { RouteHandler } from "./types";

// ---- v3 chat pane: structured thread transcript (spec §6/§7/§8) ------
// GET /api/v3/threads/:id/messages?limit&offset → ChatPart[]
/** Returns null on no path/method match. */
export const threadMessages: RouteHandler = async ({ req, url, opts }) => {
  const m = /^\/api\/v3\/threads\/([^/]+)\/messages$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const threadId = decodeURIComponent(m[1]);
    const limit = clampInt(url.searchParams.get("limit"), 200, 1, 5000);
    const rawOffset = url.searchParams.get("offset");
    const offset = rawOffset === "-1" ? -1 : clampInt(rawOffset, 0, 0, 1_000_000);
    try {
      const { getThreadParts } = await import("../services/threadParts");
      const { threadId: tid, parts, total } = await getThreadParts(threadId, limit, offset, opts.getSnapshot().jobs, opts.getSnapshot().settings.ticketProject, opts.getSnapshot().settings.ticketTeam, opts.getSnapshot().settings.securityIssueTrackerUrl);
      return json({ threadId: tid, parts, total } satisfies ThreadMessagesResponse);
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500);
    }
  }
  return null;
};

// GET /api/v3/threads/:id/stream → AG-UI STATE_SNAPSHOT / STATE_DELTA.
// State contains rich transcript parts and queue status.
/** Returns null on no path/method match. */
export const threadStream: RouteHandler = async ({ req, url, sseResponse, opts }) => {
  const m = /^\/api\/v3\/threads\/([^/]+)\/stream$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const threadId = decodeURIComponent(m[1]);
    const { getThreadParts, seedParser, tail, TranscriptParser } = await import("../services/threadParts");
    return sseResponse(req, (send) => {
      let parser = new TranscriptParser();
      let byteOffset = 0;
      let lastStatus: string | null = null;
      let stopped = false;
      let polling = false;
      let initialized = false;
      let showingQueued = false;
      const partIndexes = new Map<string, number>();

      // Seeding and polling are serialized: an overlapping tail can otherwise
      // duplicate parts or overwrite the parser before the initial read ends.
      const pollTranscript = async (): Promise<void> => {
        if (polling || stopped) return;
        polling = true;
        try {
          if (!initialized) {
            // Send an indexed, bounded SQL page before restoring the complete
            // streaming parser. Long histories must not hold up first paint.
            const page = await getThreadParts(threadId, 200, -1, opts.getSnapshot().jobs, opts.getSnapshot().settings.ticketProject, opts.getSnapshot().settings.ticketTeam, opts.getSnapshot().settings.securityIssueTrackerUrl);
            if (stopped) return;
            send({ type: "STATE_SNAPSHOT", snapshot: {
              parts: page.parts, status: currentStatus(), olderCount: Math.max(0, (page.total ?? 0) - page.parts.length),
            } });
            await new Promise(resolve => setTimeout(resolve, 0));
            const seed = await seedParser(threadId);
            if (stopped) return;
            parser = seed.parser;
            byteOffset = seed.byteOffset;
            parser.parts.forEach((part, index) => partIndexes.set(part.id, index));
            showingQueued = parser.parts.length === 0 && page.parts.length > 0;
            const latest = showingQueued ? page.parts : parser.parts.slice(-200);
            // Authoritative replacement also handles a transcript rotation
            // between the initial SQL page and parser restoration.
            if (JSON.stringify(latest) !== JSON.stringify(page.parts)) send({
              type: "STATE_SNAPSHOT", snapshot: { parts: latest, status: currentStatus(),
                olderCount: Math.max(0, parser.parts.length - latest.length) },
            });
            initialized = true;
          } else {
            const res = await tail(threadId, byteOffset, parser);
            if (stopped) return;
            byteOffset = res.byteOffset;
            if (showingQueued && parser.parts.length === 0) return;
            if (res.reset || (showingQueued && parser.parts.length > 0)) {
              showingQueued = false;
              partIndexes.clear();
              parser.parts.forEach((part, index) => partIndexes.set(part.id, index));
              send({
                type: "STATE_SNAPSHOT",
                snapshot: { parts: parser.parts.slice(-200), status: currentStatus(), olderCount: Math.max(0, parser.parts.length - 200) },
              });
              return;
            }
            if (res.parts.length) send({ type: "STATE_DELTA", delta: res.parts.map(part => {
              const index = partIndexes.get(part.id);
              if (index === undefined) {
                partIndexes.set(part.id, partIndexes.size);
                return { op: "add" as const, path: "/parts/-", value: part };
              }
              return { op: "replace" as const, path: `/parts/${index}`, value: part };
            }) });
          }
        } catch {
          // Retry transient reads on the next tick, including failed seeding.
        } finally {
          polling = false;
        }
      };

      // Emit a queue-status delta for this thread (queued/running/done).
      const currentStatus = (): "queued" | "running" | "done" | "error" => {
        const rows = getHookQueue().list({ threadId, limit: 50, includePayload: false });
        let status: "queued" | "running" | "done" | "error" = "done";
        if (rows.some((r) => r.status === "running")) status = "running";
        else if (rows.some((r) => r.status === "pending")) status = "queued";
        else if (rows.some((r) => r.status === "failed")) status = "error";
        return status;
      };
      const emitStatus = (): void => {
        if (!initialized || stopped) return;
        const status = currentStatus();
        if (status !== lastStatus) {
          lastStatus = status;
          send({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/status", value: status }] });
        }
      };

      const interval = setInterval(() => {
        void pollTranscript();
        emitStatus();
      }, 1000);
      void pollTranscript();
      const unsubscribe = getHookQueue().subscribe(emitStatus);
      return () => {
        stopped = true;
        clearInterval(interval);
        unsubscribe();
      };
    });
  }
  return null;
};

// POST /api/v3/threads/:id/message {text} → enqueue a web:message turn.
/** Returns null on no path/method match. */
export const threadMessage: RouteHandler = async ({ req, url }) => {
  const m = /^\/api\/v3\/threads\/([^/]+)\/message$/.exec(url.pathname);
  if (m && req.method === "POST") {
    const threadId = decodeURIComponent(m[1]);
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ ok: false, error: "text required" }, 400);
    // Resolve jobName/scope/prRepo/prNumber from an existing queue row
    // for the thread (the thread was created by a hook delivery).
    const queue = getHookQueue();
    const existing = queue.list({ threadId, limit: 1 })[0];
    if (!existing) {
      return json({ ok: false, error: "no queue row for thread — cannot resolve job" }, 404);
    }
    const id = `user-${randomUUID()}`;
    const inserted = queue.enqueue({
      id,
      threadId,
      jobName: existing.jobName,
      event: "web:message",
      scope: existing.scope,
      payload: { type: "user-message", text },
      prRepo: existing.prRepo,
      prNumber: existing.prNumber,
    });
    // enqueue() emits to queue subscribers itself, so the queue SSE and
    // the v3 stream's status poll both observe this without extra wiring.
    return json({ ok: inserted, id });
  }
  return null;
};
