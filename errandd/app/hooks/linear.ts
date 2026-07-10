import { type LinearPayload, readLinearPayload } from "../../shared/hookPayload";
import { type Delivery, type DeliveryRoutine, recordDelivery } from "./deliveries";
import { extractHookPk } from "./evaluate";
import { linearRuleSkipReason, matchLinearRule } from "./match";
import type { ReceiverResult, WebhookDeps } from "./receiver";
import { defaultLinearRule } from "./schema";
import { handleSignedWebhook, type WebhookSpec } from "./webhookEnvelope";

/**
 * Linear webhook receiver.
 *
 * Surfaces Linear tickets/comments as a fifth hook source (v3 "Tickets" section
 * + Deliveries tab) and fires routines with an `on.linear` rule.
 *
 *   - verifies the `Linear-Signature` HMAC (Linear's signing secret, in
 *     ERRANDD_LINEAR_WEBHOOK_SECRET; unset ⇒ accept as-is for dev),
 *   - dedups on the `Linear-Delivery` id,
 *   - computes the bot @mention (the common gate) from the ticket/comment text,
 *   - matches each routine's `on.linear` rule and fires it via onHookFire,
 *   - records the delivery + evaluation (source "linear") for the UI.
 *
 * The content-type guard, HMAC auth, dedup, and evaluation recording are the
 * shared `handleSignedWebhook` pipeline; only the id/summary/@mention
 * derivation and the match body are Linear-specific (passed as the
 * `WebhookSpec`).
 *
 * Webhook + signature docs: https://developers.linear.app/docs/graphql/webhooks
 */

export function getLinearSecret(): string {
  return process.env.ERRANDD_LINEAR_WEBHOOK_SECRET ?? "";
}

/** Bot handle to look for in ticket/comment text (e.g. "@errandd"). */
export function getLinearBotMention(): string {
  return process.env.ERRANDD_LINEAR_BOT_MENTION ?? "@errandd";
}

export function handleLinearWebhook(
  req: Request,
  deps: WebhookDeps = {},
): Promise<ReceiverResult> {
  const spec: WebhookSpec = {
    source: "linear",
    auth: { kind: "hmac", header: "linear-signature", secret: getLinearSecret() },
    deriveIdentity: (req2, payload) => {
      const lp = readLinearPayload(payload);
      lp.mentioned = mentionsBot(lp, getLinearBotMention());
      const summary = [
        "linear",
        lp.type,
        lp.identifier || null,
        lp.title || null,
        lp.mentioned ? "@mention" : "no-mention",
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        event: `linear:${lp.type}${lp.action ? `.${lp.action}` : ""}`.toLowerCase(),
        id: req2.headers.get("linear-delivery") ?? `linear-${Date.now().toString(36)}`,
        summary,
      };
    },
    match: ({ payload, identity, delivery, deps: d }) =>
      matchLinear(payload, identity.event, identity.id, delivery, d),
    // Linear prefers the issue identifier (`ENG-123`) as the delivery pk, falling
    // back to the generic GitHub-style derivation.
    derivePk: (event, payload) => readLinearPayload(payload).identifier || extractHookPk(event, payload),
    recordAttempt: (req2, body, status) => recordLinearAttempt(req2, body, status),
  };
  return handleSignedWebhook(req, deps, spec);
}

/** Per-job Linear match pass. The @mention gate lives inside `matchLinearRule`
 *  (it reads `lp.mentioned`, which the receiver sets from the bot handle). */
async function matchLinear(
  payload: unknown,
  event: string,
  id: string,
  delivery: Delivery,
  deps: WebhookDeps,
): Promise<DeliveryRoutine[]> {
  const routines: DeliveryRoutine[] = [];
  // Re-derive the payload + @mention exactly as deriveIdentity did, so the
  // matcher sees the same `mentioned` bit (the gate) it surfaced in the summary.
  const lp = readLinearPayload(payload);
  lp.mentioned = mentionsBot(lp, getLinearBotMention());
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
  return routines;
}

/** Does the ticket/comment text @mention the bot handle? */
function mentionsBot(lp: LinearPayload, handle: string): boolean {
  if (!handle) {
    return false;
  }
  return lp.text.toLowerCase().includes(handle.toLowerCase());
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
