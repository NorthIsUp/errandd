import { createHmac, timingSafeEqual } from "node:crypto";
import {
  attachDeliveryPayload,
  type Delivery,
  recordDelivery,
  setDeliveryEvaluation,
} from "./deliveries";
import { extractHookFields, extractHookKeys, extractHookPk } from "./evaluate";
import type { ReceiverResult, WebhookDeps } from "./receiver";

/**
 * Linear webhook receiver — STUB.
 *
 * Surfaces Linear tickets/comments that **@mention the bot** as a fifth hook
 * source (v3 "Tickets" section + Deliveries tab). Scope of this stub:
 *
 *   - verifies the `Linear-Signature` HMAC (secret in
 *     CLAWDCODE_LINEAR_WEBHOOK_SECRET; unset ⇒ accept as-is for dev),
 *   - dedups on the `Linear-Delivery` id,
 *   - **gates on the bot @mention** — a payload whose issue description /
 *     comment body does not mention the bot handle is accepted with no match,
 *   - records the delivery + evaluation (source "linear") so it appears in the
 *     UI.
 *
 * STUB: job matching is not wired yet. There is no `hookConfig.linear` rule or
 * matcher, so a mentioned ticket is recorded but does NOT enqueue any routine.
 * Adding the rule schema + matcher (mirroring sentry/datadog) + onHookFire is
 * the follow-up — tracked in TODO.md.
 *
 * Webhook + signature docs: https://developers.linear.app/docs/graphql/webhooks
 */

export function getLinearSecret(): string {
  return process.env.CLAWDCODE_LINEAR_WEBHOOK_SECRET ?? "";
}

/** Bot handle to look for in ticket/comment text (e.g. "@clawd"). */
function botMention(): string {
  return process.env.CLAWDCODE_LINEAR_BOT_MENTION ?? "@clawd";
}

export async function handleLinearWebhook(
  req: Request,
  _deps: WebhookDeps = {},
): Promise<ReceiverResult> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return { status: 415, body: { ok: false, error: "json required" } };
  }

  const rawBody = await req.text();

  const secret = getLinearSecret();
  if (secret) {
    const sig = req.headers.get("linear-signature") ?? "";
    if (!verifyLinearSignature(secret, sig, rawBody)) {
      recordLinearAttempt(req, rawBody, "bad-signature");
      return { status: 401, body: { ok: false, error: "bad signature" } };
    }
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    recordLinearAttempt(req, rawBody, "error");
    return { status: 400, body: { ok: false, error: "invalid json" } };
  }

  const lp = readLinearPayload(payload);
  const event = `linear:${lp.type}${lp.action ? `.${lp.action}` : ""}`.toLowerCase();
  const id = req.headers.get("linear-delivery") ?? `linear-${Date.now().toString(36)}`;

  const mentioned = mentionsBot(lp, botMention());
  const summary = [
    "linear",
    lp.type,
    lp.identifier || null,
    lp.title || null,
    mentioned ? "@mention" : "no-mention",
  ]
    .filter(Boolean)
    .join(" · ");

  const delivery: Delivery = {
    id,
    event,
    receivedAt: Date.now(),
    summary,
    status: "ok",
    matched: [],
    payloadSnippet: rawBody.slice(0, 2048),
  };

  const fresh = recordDelivery(delivery);
  if (!fresh) {
    delivery.status = "duplicate";
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  // STUB: @mention gating only. A mentioned ticket is recorded for visibility
  // but no routine is fired yet (no linear matcher). Un-mentioned tickets are
  // accepted and ignored.
  attachDeliveryPayload(id, payload);
  setDeliveryEvaluation(id, {
    source: "linear",
    pk: lp.identifier || extractHookPk(event, payload),
    keys: extractHookKeys(event, payload),
    fields: extractHookFields(event, payload),
    routines: [],
  });

  // STUB: nothing fired; `mentioned` is reflected in the recorded delivery
  // summary, not the response body (ReceiverResult only carries ok/matched).
  return { status: 200, body: { ok: true } };
}

interface LinearPayloadView {
  type: string;
  action: string | null;
  identifier: string | null;
  title: string | null;
  /** All free-text fields worth scanning for the @mention. */
  text: string;
}

/** Best-effort read of the fields we care about from a Linear webhook body. */
function readLinearPayload(payload: unknown): LinearPayloadView {
  const p = (payload ?? {}) as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const issue = (data.issue ?? {}) as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "Issue";
  const action = typeof p.action === "string" ? p.action : null;
  const identifier = str(data.identifier) ?? str(issue.identifier) ?? null;
  const title = str(data.title) ?? str(issue.title) ?? null;
  const text = [data.description, data.body, issue.description, p.url]
    .map((v) => (typeof v === "string" ? v : ""))
    .join("\n");
  return { type, action, identifier, title, text };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Does the ticket/comment text @mention the bot? */
function mentionsBot(lp: LinearPayloadView, handle: string): boolean {
  if (!handle) {
    return false;
  }
  return lp.text.toLowerCase().includes(handle.toLowerCase());
}

/** HMAC-SHA256 of the raw body, hex-compared constant-time against the
 *  `linear-signature` header. */
function verifyLinearSignature(secret: string, sig: string, body: string): boolean {
  if (!sig) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function recordLinearAttempt(req: Request, body: string, status: Delivery["status"]): void {
  const id = req.headers.get("linear-delivery") ?? `linear-${Date.now().toString(36)}`;
  recordDelivery({
    id,
    event: "linear:issue",
    receivedAt: Date.now(),
    summary: "linear · issue",
    status,
    matched: [],
    payloadSnippet: body.slice(0, 2048),
  });
}
