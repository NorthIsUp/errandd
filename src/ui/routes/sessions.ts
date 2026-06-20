import { clampInt, json, withJson } from "../http";
import {
  getSessionEffort,
  getSessionGoal,
  getSessionModel,
  normalizeTitle,
  setSessionClosed,
  setSessionEffort,
  setSessionGoal,
  setSessionModel,
  setSessionTitle,
} from "../services/session-meta";
import { listAgents, listSessions, readSessionMessages } from "../services/sessions";
import type { RouteHandler } from "./types";

/** GET /api/sessions — list sessions (?includeClosed=1). */
export const sessionsList: RouteHandler = async ({ url }) => {
  try {
    const includeClosed = url.searchParams.get("includeClosed") === "1";
    return json(await listSessions(includeClosed));
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** GET /api/agents — available agents. */
export const agents: RouteHandler = async () => {
  try {
    return json(await listAgents());
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** GET /api/sessions/:id/messages — paged transcript. Returns null on no match. */
export const sessionMessages: RouteHandler = async ({ req, url }) => {
  if (
    !(
      url.pathname.startsWith("/api/sessions/") &&
      url.pathname.endsWith("/messages") &&
      req.method === "GET"
    )
  ) {
    return null;
  }
  const sessionId = url.pathname.slice("/api/sessions/".length, -"/messages".length);
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 2000);
  const rawOffset = url.searchParams.get("offset");
  const offset = rawOffset === "-1" ? -1 : clampInt(rawOffset, 0, 0, 100_000);
  try {
    return json(await readSessionMessages(sessionId, limit, offset));
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

// Full raw webhook payload for a hook session (lazy — payloads are
// large, so they're not bundled into the session list) + reprocess.
/** GET /api/sessions/:id/hook-payload and POST .../reprocess. Returns null on no match. */
export const sessionHookPayloadOrReprocess: RouteHandler = async ({ req, url, opts }) => {
  const m = /^\/api\/sessions\/([0-9a-f-]+)\/hook-payload$/i.exec(url.pathname);
  if (m && req.method === "GET") {
    const { getSessionHookPayload } = await import("../services/session-meta");
    const stored = await getSessionHookPayload(m[1]);
    if (!stored) {
      return json({ ok: false, error: "no payload" }, 404);
    }
    return json(stored);
  }
  // Replay a stored hook delivery through the matcher with a fresh
  // delivery id, re-running (or re-skipping) it.
  const rp = /^\/api\/sessions\/([0-9a-f-]+)\/reprocess$/i.exec(url.pathname);
  if (rp && req.method === "POST") {
    const { getSessionHookPayload } = await import("../services/session-meta");
    const stored = await getSessionHookPayload(rp[1]);
    if (!stored) {
      return json({ ok: false, error: "no stored payload to reprocess" }, 404);
    }
    const { dispatchHook } = await import("../../hooks/receiver");
    const matched = await dispatchHook(
      stored.event,
      stored.payload,
      `reprocess-${crypto.randomUUID()}`,
      {
        getJobs: () => opts.getSnapshot().jobs,
        ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
        ...(opts.onHookSkip ? { onHookSkip: opts.onHookSkip } : {}),
      },
    );
    return json({ ok: true, matched });
  }
  return null;
};

// --- Session title / close / field routes ---
/** PUT .../title, POST .../close|reopen, GET/PUT .../goal|model|effort. Null on no match. */
export const sessionMeta: RouteHandler = async ({ req, url }) => {
  const titleMatch = /^\/api\/sessions\/([0-9a-f-]+)\/title$/i.exec(url.pathname);
  if (titleMatch && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    await setSessionTitle(titleMatch[1], normalizeTitle(String(body.title ?? "")));
    return json({ ok: true });
  }
  const closeMatch = /^\/api\/sessions\/([0-9a-f-]+)\/(close|reopen)$/i.exec(url.pathname);
  if (closeMatch && req.method === "POST") {
    await setSessionClosed(closeMatch[1], closeMatch[2].toLowerCase() === "close");
    return json({ ok: true });
  }
  // Per-session string fields: goal, model, effort. Each exposes a
  // matching GET/PUT pair. New fields are one-line additions below.
  const SESSION_FIELDS: Record<
    string,
    { get: (id: string) => Promise<string>; set: (id: string, v: string) => Promise<void> }
  > = {
    goal: { get: getSessionGoal, set: setSessionGoal },
    model: { get: getSessionModel, set: setSessionModel },
    effort: { get: getSessionEffort, set: setSessionEffort },
  };
  const fieldMatch = /^\/api\/sessions\/([^/]+)\/([a-z]+)$/i.exec(url.pathname);
  const fieldName = (fieldMatch?.[2] ?? "").toLowerCase();
  const fieldImpl = fieldName ? SESSION_FIELDS[fieldName] : undefined;
  if (fieldMatch && fieldImpl) {
    const id = decodeURIComponent(fieldMatch[1] ?? "");
    if (req.method === "GET") {
      return json({ [fieldName]: await fieldImpl.get(id) });
    }
    if (req.method === "PUT") {
      return withJson(async () => {
        const body = await req.json().catch(() => ({}));
        await fieldImpl.set(id, String(body[fieldName] ?? ""));
        return { ok: true };
      }, 400);
    }
  }
  return null;
};
