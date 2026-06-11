import { createHmac, timingSafeEqual } from "node:crypto";
import { type LinearPayload, readLinearPayload } from "../../shared/hookPayload";
import {
  attachDeliveryPayload,
  type Delivery,
  type DeliveryRoutine,
  recordDelivery,
  setDeliveryEvaluation,
} from "./deliveries";
import { extractHookFields, extractHookKeys, extractHookPk } from "./evaluate";
import { linearRuleSkipReason, matchLinearRule } from "./match";
import type { ReceiverResult, WebhookDeps } from "./receiver";
import { defaultLinearRule } from "./schema";

/**
 * Linear webhook receiver.
 *
 * Surfaces Linear tickets/comments as a fifth hook source (v3 "Tickets" section
 * + Deliveries tab) and fires routines with an `on.linear` rule.
 *
 *   - verifies the `Linear-Signature` HMAC (Linear's signing secret, in
 *     CLAWDCODE_LINEAR_WEBHOOK_SECRET; unset ⇒ accept as-is for dev),
 *   - dedups on the `Linear-Delivery` id,
 *   - computes the bot @mention (the common gate) from the ticket/comment text,
 *   - matches each routine's `on.linear` rule and fires it via onHookFire,
 *   - records the delivery + evaluation (source "linear") for the UI.
 *
 * Webhook + signature docs: https://developers.linear.app/docs/graphql/webhooks
 */

export function getLinearSecret(): string {
  return process.env.CLAWDCODE_LINEAR_WEBHOOK_SECRET ?? "";
}

/** Bot handle to look for in ticket/comment text (e.g. "@clawd"). */
export function getLinearBotMention(): string {
  return process.env.CLAWDCODE_LINEAR_BOT_MENTION ?? "@clawd";
}

export async function handleLinearWebhook(
  req: Request,
  deps: WebhookDeps = {},
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
  lp.mentioned = mentionsBot(lp, getLinearBotMention());
  const event = `linear:${lp.type}${lp.action ? `.${lp.action}` : ""}`.toLowerCase();
  const id = req.headers.get("linear-delivery") ?? `linear-${Date.now().toString(36)}`;

  const summary = [
    "linear",
    lp.type,
    lp.identifier || null,
    lp.title || null,
    lp.mentioned ? "@mention" : "no-mention",
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

  const routines: DeliveryRoutine[] = [];
  if (deps.getJobs && deps.onHookFire) {
    try {
      const jobs = await deps.getJobs();
      for (const job of jobs) {
        const rule = job.hookConfig?.linear;
        if (!rule) {
          continue;
        }
        const effective = rule === true ? defaultLinearRule() : rule;
        if (matchLinearRule(effective, lp)) {
          delivery.matched.push(job.name);
          routines.push({ job: job.name, outcome: "trigger" });
          void deps.onHookFire(job.name, event, id, payload);
        } else {
          routines.push({
            job: job.name,
            outcome: "skip",
            reason: linearRuleSkipReason(effective, lp),
          });
        }
      }
    } catch (err) {
      console.error("[hooks:linear] matcher error:", err);
    }
  }

  attachDeliveryPayload(id, payload);
  setDeliveryEvaluation(id, {
    source: "linear",
    pk: lp.identifier || extractHookPk(event, payload),
    keys: extractHookKeys(event, payload),
    fields: extractHookFields(event, payload),
    routines,
  });

  return {
    status: 200,
    body: {
      ok: true,
      ...(delivery.matched.length > 0 ? { matched: delivery.matched } : {}),
    },
  };
}

/** Does the ticket/comment text @mention the bot handle? */
function mentionsBot(lp: LinearPayload, handle: string): boolean {
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
