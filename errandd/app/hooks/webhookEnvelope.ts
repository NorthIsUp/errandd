import { createHmac, timingSafeEqual } from "node:crypto";
import {
  attachDeliveryPayload,
  type Delivery,
  type DeliveryRoutine,
  recordDelivery,
  setDeliveryEvaluation,
  summarize,
} from "./deliveries";
import { extractHookFields, extractHookKeys, extractHookPk } from "./evaluate";
import type { ReceiverResult, WebhookDeps } from "./receiver";
import type { DeliverySource } from "../../shared/deliveryTypes";

/**
 * Shared signed-webhook envelope.
 *
 * The four receivers (github / sentry / datadog / linear) all repeat the same
 * pipeline: content-type guard → `req.text()` → auth (HMAC or shared token) →
 * `JSON.parse` → derive event/id/summary → build a `Delivery` → `recordDelivery`
 * (dedup short-circuit) → per-receiver match loop → `setDeliveryEvaluation` →
 * `200 {ok, matched?}`. Only the auth header, the id/summary derivation, the
 * evaluation `source`, and the match body genuinely differ.
 *
 * `handleSignedWebhook` owns the invariant skeleton; each receiver passes a
 * `WebhookSpec` describing the parts that differ. The match body is a callback
 * so each receiver keeps its distinct behaviour (github fans out to
 * `dispatchHook`; sentry/datadog resolve `true` → safe default then match;
 * linear is @mention-gated and fires nothing). Behaviour is identical to the
 * hand-rolled receivers — this is a pure extraction.
 */

/**
 * Authentication strategy for a webhook source. Both variants are no-ops when
 * the configured secret is empty (opt-in verification; dev/testing accepts
 * deliveries as-is — the receiver-status endpoint surfaces which mode is live).
 */
export type WebhookAuth =
  | {
      /** HMAC-SHA256 of the raw body, hex-compared constant-time against
       *  the named header (github / sentry / linear). */
      kind: "hmac";
      header: string;
      secret: string;
      /** Optional `sha256=<hex>` prefix unwrap (github). When omitted the
       *  header value is the bare hex digest (sentry / linear). */
      prefix?: string;
    }
  | {
      /** Shared-token equality: the secret must arrive as a header value or a
       *  `?token=` query param (datadog — payloads are not HMAC-signed). */
      kind: "token";
      header: string;
      secret: string;
    };

export interface DeliveryIdentity {
  /** Event label threaded to jobs (`pull_request`, `sentry:issue`, …). */
  event: string;
  /** Dedup id (delivery header or a derived stable key). */
  id: string;
  /** Human summary shown in the Deliveries table. */
  summary: string;
}

/**
 * The match phase: run the receiver's per-job logic against the parsed payload
 * and the already-recorded delivery. Push fired job names onto `delivery.matched`
 * and return the structured per-routine outcomes (recorded onto the delivery's
 * evaluation). Returning `[]` is valid (linear fires nothing).
 */
export type WebhookMatch = (ctx: {
  payload: unknown;
  identity: DeliveryIdentity;
  delivery: Delivery;
  deps: WebhookDeps;
}) => Promise<DeliveryRoutine[]> | DeliveryRoutine[];

export interface WebhookSpec {
  /** Evaluation `source` tag (`github`/`sentry`/`datadog`/`linear`). */
  source: DeliverySource;
  /** Per-source authentication. */
  auth: WebhookAuth;
  /** Derive event/id/summary from the parsed payload + request. */
  deriveIdentity: (req: Request, payload: unknown) => DeliveryIdentity;
  /** Per-receiver match body. */
  match: WebhookMatch;
  /** Record a failed-auth / bad-json attempt so it still shows in the table.
   *  Receivers keep their distinct attempt summaries. */
  recordAttempt: (req: Request, body: string, status: Delivery["status"]) => void;
  /** Override the evaluation `pk` (linear prefers `data.identifier`). Defaults
   *  to `extractHookPk(event, payload)`. */
  derivePk?: (event: string, payload: unknown) => string;
  /**
   * Who records the delivery evaluation (`attachDeliveryPayload` +
   * `setDeliveryEvaluation`):
   *   - `"envelope"` (default): the envelope records it unconditionally after
   *     the match phase (sentry / datadog / linear — they always enrich, even
   *     when no job is interested).
   *   - `"match"`: the match callback owns recording (github — `dispatchHook`
   *     only enriches when `getJobs`/`onHookFire` deps are present, so the
   *     envelope must NOT record on its behalf).
   */
  evaluate?: "envelope" | "match";
}

/**
 * Verify an HMAC-SHA256 signature, hex-compared constant-time. Unifies the
 * previously-duplicated github / sentry / linear verifiers; the only prior
 * difference was the header name and github's `sha256=` prefix.
 */
export function verifyHmac(
  secret: string,
  sigHeader: string,
  body: string,
  prefix?: string,
): boolean {
  let hex = sigHeader;
  if (prefix) {
    if (!sigHeader.toLowerCase().startsWith(prefix.toLowerCase())) {
      return false;
    }
    hex = sigHeader.slice(prefix.length);
    if (!/^[0-9a-f]+$/i.test(hex)) {
      return false;
    }
  }
  if (!hex) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(hex, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Constant-time string equality (shared-token auth). */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Apply the auth strategy. Returns true when authenticated (or when the
 *  secret is unset → opt-in verification disabled). */
function authenticate(req: Request, body: string, auth: WebhookAuth): boolean {
  if (!auth.secret) {
    return true;
  }
  if (auth.kind === "hmac") {
    const sig = req.headers.get(auth.header) ?? "";
    return verifyHmac(auth.secret, sig, body, auth.prefix);
  }
  const url = new URL(req.url);
  const provided = req.headers.get(auth.header) ?? url.searchParams.get("token") ?? "";
  return constantTimeEquals(provided, auth.secret);
}

/**
 * The shared signed-webhook pipeline. See module doc. Returns the same
 * `ReceiverResult` shape every receiver already returned.
 */
export async function handleSignedWebhook(
  req: Request,
  deps: WebhookDeps,
  spec: WebhookSpec,
): Promise<ReceiverResult> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return { status: 415, body: { ok: false, error: "json required" } };
  }

  const rawBody = await req.text();

  if (!authenticate(req, rawBody, spec.auth)) {
    spec.recordAttempt(req, rawBody, "bad-signature");
    const error = spec.auth.kind === "token" ? "bad token" : "bad signature";
    return { status: 401, body: { ok: false, error } };
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    spec.recordAttempt(req, rawBody, "error");
    return { status: 400, body: { ok: false, error: "invalid json" } };
  }

  const identity = spec.deriveIdentity(req, payload);

  const delivery: Delivery = {
    id: identity.id,
    event: identity.event,
    receivedAt: Date.now(),
    summary: identity.summary,
    status: "ok",
    matched: [],
    payloadSnippet: rawBody.slice(0, 2048),
  };

  const fresh = recordDelivery(delivery);
  if (!fresh) {
    delivery.status = "duplicate";
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const routines = await spec.match({ payload, identity, delivery, deps });

  if ((spec.evaluate ?? "envelope") === "envelope") {
    attachDeliveryPayload(identity.id, payload);
    setDeliveryEvaluation(identity.id, {
      source: spec.source,
      pk: spec.derivePk
        ? spec.derivePk(identity.event, payload)
        : extractHookPk(identity.event, payload),
      keys: extractHookKeys(identity.event, payload),
      fields: extractHookFields(identity.event, payload),
      routines,
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      ...(delivery.matched.length > 0 ? { matched: delivery.matched } : {}),
    },
  };
}

/** Re-export `summarize` so receivers that need it (github) have a single
 *  import surface alongside the envelope. */
export { summarize };
