import type { QueuedMessage } from "../../hookQueue";
import type { StartWebUiOptions } from "../types";

/**
 * Per-request context handed to every route handler. Carries the parsed
 * URL, the raw Request, and the daemon options bag (`getSnapshot`,
 * callbacks, token, …). Host validation, CSRF, the pre-auth exceptions,
 * and the bearer-token gate all run in the dispatcher BEFORE a handler is
 * ever invoked, so handlers can assume the request is authorized.
 */
export interface RouteCtx {
  req: Request;
  url: URL;
  opts: StartWebUiOptions;
  /**
   * Build a Server-Sent-Events Response. Shared with the dispatcher so the
   * encoder, 25s heartbeat, abort cleanup, and SSE headers stay identical
   * across the job-status, deliveries, hook-queue, and v3 streams.
   */
  sseResponse: (req: Request, setup: (send: (data: unknown) => void) => () => void) => Response;
}

/**
 * A route handler returns a `Response` when it handled the request, or
 * `null` to fall through to the next route (preserving the original
 * if-ladder semantics where a regex branch could match the path but not
 * the method/sub-pattern and let a later branch win). Async because most
 * handlers parse a body or dynamic-import a service.
 */
export type RouteHandler = (ctx: RouteCtx) => Promise<Response | null> | Response | null;

/**
 * A table entry. Two shapes, both consumed by the dispatcher in array order
 * (the order mirrors the original if-ladder so fall-through precedence is
 * preserved exactly):
 *
 *  - `{ method, path, handler }` — exact match: invoked only when
 *    `req.method === method && url.pathname === path`. Drives the proper-405
 *    response for a known path hit with the wrong method.
 *  - `{ match: "self", methods, paths, handler }` — the handler owns its own
 *    path+method matching (regex / prefix / sub-pattern) and returns `null`
 *    to fall through to the next entry. `methods`/`paths` are metadata used
 *    only to compute the 405 allow-set; they never gate dispatch.
 */
export type Route =
  | { method: string; path: string; handler: RouteHandler }
  | {
      match: "self";
      handler: RouteHandler;
      /** Predicate: does this self-matching route own `url.pathname`? */
      owns: (url: URL) => boolean;
      /** HTTP methods this route serves for an owned path (for 405). */
      methods: readonly string[];
    };

/** Queue message minus the heavy `payload` — what the queue API/SSE send. */
export function queueMessageForWire(m: QueuedMessage): Omit<QueuedMessage, "payload"> {
  const { payload: _payload, ...rest } = m;
  return rest;
}
