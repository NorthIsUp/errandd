import { createHmac, timingSafeEqual } from "node:crypto";
import {
  attachDeliveryPayload,
  type Delivery,
  type DeliveryRoutine,
  recordDelivery,
  setDeliveryEvaluation,
} from "./deliveries";
import { extractHookFields, extractHookPk } from "./evaluate";
import { matchSentryRule, readSentryPayload, sentryRuleSkipReason } from "./match";
import type { WebhookDeps } from "./receiver";
import { defaultSentryRule } from "./schema";

/**
 * Sentry integration-platform webhook receiver.
 *
 * https://docs.sentry.io/integrations/integration-platform/webhooks/
 *
 * - Verifies `Sentry-Hook-Signature` (HMAC-SHA256 of the raw body using the
 *   integration Client Secret in CLAWDCODE_SENTRY_CLIENT_SECRET). When the
 *   secret is unset, deliveries are accepted as-is (dev/testing).
 * - Dedups on the `Request-ID` header.
 * - The resource type comes from `Sentry-Hook-Resource` (issue, error,
 *   event_alert, metric_alert, comment, …) and is threaded to jobs as the
 *   event `sentry:<resource>`.
 */

export function getSentrySecret(): string {
  return process.env.CLAWDCODE_SENTRY_CLIENT_SECRET ?? "";
}

export interface ReceiverResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; error?: string; matched?: string[] };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: signature verify + dedup + per-job match-or-skip read clearly inline; extracting pieces hurts more than it helps.
export async function handleSentryWebhook(
  req: Request,
  deps: WebhookDeps = {},
): Promise<ReceiverResult> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return { status: 415, body: { ok: false, error: "json required" } };
  }

  const rawBody = await req.text();

  const secret = getSentrySecret();
  if (secret) {
    const sig = req.headers.get("sentry-hook-signature") ?? "";
    if (!verifySentrySignature(secret, sig, rawBody)) {
      recordSentryAttempt(req, rawBody, "bad-signature");
      return { status: 401, body: { ok: false, error: "bad signature" } };
    }
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    recordSentryAttempt(req, rawBody, "error");
    return { status: 400, body: { ok: false, error: "invalid json" } };
  }

  const resource = req.headers.get("sentry-hook-resource") ?? "event";
  const event = `sentry:${resource}`;
  const id = req.headers.get("request-id") ?? `sentry-${Date.now().toString(36)}`;

  const sp = readSentryPayload(payload);
  const summary = [
    "sentry",
    resource,
    sp?.action || null,
    sp?.project ? `project=${sp.project}` : null,
    sp?.level || null,
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
  if (deps.getJobs && deps.onHookFire && sp) {
    try {
      const jobs = await deps.getJobs();
      for (const job of jobs) {
        const rule = job.hookConfig?.sentry;
        if (!rule) {
          continue;
        }
        // `true` resolves to the prod-only default (parseSentry normalizes it,
        // but guard here too so a programmatic `true` can't match all projects).
        const effective = rule === true ? defaultSentryRule() : rule;
        if (matchSentryRule(effective, sp)) {
          delivery.matched.push(job.name);
          routines.push({ job: job.name, outcome: "trigger" });
          void deps.onHookFire(job.name, event, id, payload);
        } else {
          routines.push({
            job: job.name,
            outcome: "skip",
            reason: sentryRuleSkipReason(effective, sp),
          });
        }
      }
    } catch (err) {
      console.error("[hooks:sentry] matcher error:", err);
    }
  }
  attachDeliveryPayload(id, payload);
  setDeliveryEvaluation(id, {
    source: "sentry",
    pk: extractHookPk(event, payload),
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

/** HMAC-SHA256 of the raw body, hex-compared constant-time against the
 *  `sentry-hook-signature` header. */
function verifySentrySignature(secret: string, sig: string, body: string): boolean {
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

function recordSentryAttempt(req: Request, body: string, status: Delivery["status"]): void {
  const resource = req.headers.get("sentry-hook-resource") ?? "event";
  const id = req.headers.get("request-id") ?? `sentry-${Date.now().toString(36)}`;
  recordDelivery({
    id,
    event: `sentry:${resource}`,
    receivedAt: Date.now(),
    summary: `sentry · ${resource}`,
    status,
    matched: [],
    payloadSnippet: body.slice(0, 2048),
  });
}
