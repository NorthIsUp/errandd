import { randomUUID } from "node:crypto";
import { getHookQueue } from "../../hookQueue";
import { clampInt, json } from "../http";
import type { ChatPart, ThreadMessagesResponse } from "../services/threadParts";
import type { RouteHandler } from "./types";

// ---- v3 chat pane: structured thread transcript (spec §6/§7/§8) ------
// GET /api/v3/threads/:id/messages?limit&offset → ChatPart[]
/** Returns null on no path/method match. */
export const threadMessages: RouteHandler = async ({ req, url }) => {
  const m = /^\/api\/v3\/threads\/([^/]+)\/messages$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const threadId = decodeURIComponent(m[1]);
    const limit = clampInt(url.searchParams.get("limit"), 200, 1, 5000);
    const rawOffset = url.searchParams.get("offset");
    const offset = rawOffset === "-1" ? -1 : clampInt(rawOffset, 0, 0, 1_000_000);
    try {
      const { getThreadParts } = await import("../services/threadParts");
      const { threadId: tid, parts, total } = await getThreadParts(threadId, limit, offset);
      return json({ threadId: tid, parts, total } satisfies ThreadMessagesResponse);
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500);
    }
  }
  return null;
};

// GET /api/v3/threads/:id/stream → SSE snapshot, then append/update
// deltas as the jsonl grows, merged with queue-status deltas.
/** Returns null on no path/method match. */
export const threadStream: RouteHandler = async ({ req, url, sseResponse }) => {
  const m = /^\/api\/v3\/threads\/([^/]+)\/stream$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const threadId = decodeURIComponent(m[1]);
    const { seedParser, tail, TranscriptParser } = await import("../services/threadParts");
    return sseResponse(req, (send) => {
      let parser = new TranscriptParser();
      let byteOffset = 0;
      const seenToolIds = new Set<string>();
      let lastStatus: string | null = null;

      const noteToolIds = (parts: ChatPart[]): void => {
        for (const p of parts) {
          if (p.kind === "tool" && p.tool.toolCallId) seenToolIds.add(p.tool.toolCallId);
        }
      };

      // Initial snapshot — seed the streaming parser from the full
      // transcript so the live tail shares its open-tool state.
      void (async () => {
        try {
          const seed = await seedParser(threadId);
          parser = seed.parser;
          byteOffset = seed.byteOffset;
          send({ type: "snapshot", parts: parser.parts });
          noteToolIds(parser.parts);
        } catch {
          send({ type: "snapshot", parts: [] });
        }
      })();

      // Poll the transcript for appended bytes and emit deltas.
      const pollTranscript = async (): Promise<void> => {
        try {
          const res = await tail(threadId, byteOffset, parser);
          byteOffset = res.byteOffset;
          for (const part of res.parts) {
            if (part.kind === "tool" && part.tool.toolCallId) {
              if (seenToolIds.has(part.tool.toolCallId)) {
                send({ type: "update", part });
              } else {
                seenToolIds.add(part.tool.toolCallId);
                send({ type: "append", parts: [part] });
              }
            } else {
              send({ type: "append", parts: [part] });
            }
          }
        } catch {
          // transient read error — try again next tick
        }
      };

      // Emit a queue-status delta for this thread (queued/running/done).
      const emitStatus = (): void => {
        const rows = getHookQueue().list({ threadId, limit: 50 });
        let status: "queued" | "running" | "done" | "error" = "done";
        if (rows.some((r) => r.status === "running")) status = "running";
        else if (rows.some((r) => r.status === "pending")) status = "queued";
        else if (rows.some((r) => r.status === "failed")) status = "error";
        if (status !== lastStatus) {
          lastStatus = status;
          send({ type: "status", status });
        }
      };

      const interval = setInterval(() => {
        void pollTranscript();
        emitStatus();
      }, 1000);
      emitStatus();
      const unsubscribe = getHookQueue().subscribe(emitStatus);
      return () => {
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
