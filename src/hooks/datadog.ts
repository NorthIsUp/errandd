import { timingSafeEqual } from "node:crypto";
import {
  attachDeliveryPayload,
  type Delivery,
  type DeliveryRoutine,
  recordDelivery,
  setDeliveryEvaluation,
} from "./deliveries";
import { extractHookFields, extractHookPk } from "./evaluate";
import { datadogRuleSkipReason, matchDatadogRule, readDatadogPayload } from "./match";
import type { WebhookDeps } from "./receiver";

/**
 * Datadog webhook receiver.
 *
 * https://docs.datadoghq.com/integrations/webhooks/
 *
 * Datadog webhooks are NOT HMAC-signed — the payload is fully user-defined.
 * clawdcode authenticates with a shared token: the value of
 * CLAWDCODE_DATADOG_WEBHOOK_SECRET must arrive either as the
 * `X-Clawdcode-Token` header or a `?token=` query param. When the secret is
 * unset, deliveries are accepted as-is (dev/testing).
 *
 * Because the payload shape is user-controlled, clawdcode recommends a
 * canonical webhook payload template in the Datadog integration config
 * (see RECOMMENDED_DATADOG_PAYLOAD). Matching keys off those field names.
 */

export function getDatadogSecret(): string {
  return process.env.CLAWDCODE_DATADOG_WEBHOOK_SECRET ?? "";
}

/** The payload template clawdcode recommends pasting into the Datadog
 *  webhook "Payload" field. Surfaced by the receiver-status endpoint so
 *  the Settings UI can show a copy-paste block. */
export const RECOMMENDED_DATADOG_PAYLOAD = {
  id: "$ID",
  monitor_id: "$ALERT_ID",
  title: "$EVENT_TITLE",
  message: "$EVENT_MSG",
  type: "$ALERT_TYPE",
  priority: "$ALERT_PRIORITY",
  transition: "$ALERT_TRANSITION",
  status: "$ALERT_STATUS",
  aggreg_key: "$AGGREG_KEY",
  link: "$LINK",
  tags: "$TAGS",
  org_id: "$ORG_ID",
  hostname: "$HOSTNAME",
  date: "$DATE",
} as const;

export interface ReceiverResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; error?: string; matched?: string[] };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: token auth + dedup + per-job match-or-skip read clearly inline; extracting pieces hurts more than it helps.
export async function handleDatadogWebhook(
  req: Request,
  deps: WebhookDeps = {},
): Promise<ReceiverResult> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return { status: 415, body: { ok: false, error: "json required" } };
  }

  const rawBody = await req.text();

  const secret = getDatadogSecret();
  if (secret) {
    const url = new URL(req.url);
    const provided = req.headers.get("x-clawdcode-token") ?? url.searchParams.get("token") ?? "";
    if (!constantTimeEquals(provided, secret)) {
      recordDatadogAttempt(rawBody, "bad-signature");
      return { status: 401, body: { ok: false, error: "bad token" } };
    }
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    recordDatadogAttempt(rawBody, "error");
    return { status: 400, body: { ok: false, error: "invalid json" } };
  }

  const event = "datadog:alert";
  const dp = readDatadogPayload(payload);
  // Datadog has no delivery id header. Use aggreg_key + transition so a
  // re-alert and its recovery dedup independently but a duplicate POST of
  // the same transition collapses.
  const id = deriveDatadogId(payload);

  const summary = [
    "datadog",
    dp?.type || null,
    dp?.priority || null,
    dp?.monitor ? `monitor=${dp.monitor}` : null,
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
  if (deps.getJobs && deps.onHookFire && dp) {
    try {
      const jobs = await deps.getJobs();
      for (const job of jobs) {
        const rule = job.hookConfig?.datadog;
        if (!rule) {
          continue;
        }
        if (rule === true || matchDatadogRule(rule, dp)) {
          delivery.matched.push(job.name);
          routines.push({ job: job.name, outcome: "trigger" });
          void deps.onHookFire(job.name, event, id, payload);
        } else {
          routines.push({
            job: job.name,
            outcome: "skip",
            reason: datadogRuleSkipReason(rule, dp),
          });
        }
      }
    } catch (err) {
      console.error("[hooks:datadog] matcher error:", err);
    }
  }
  attachDeliveryPayload(id, payload);
  setDeliveryEvaluation(id, {
    source: "datadog",
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

/** Build a dedup id from stable payload fields. Falls back to a clock
 *  stamp so a payload missing the canonical fields still records. */
function deriveDatadogId(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const p = payload as Record<string, unknown>;
    const agg = typeof p.aggreg_key === "string" ? p.aggreg_key : "";
    const transition = typeof p.transition === "string" ? p.transition : "";
    const id = typeof p.id === "string" ? p.id : "";
    const key = [agg || id, transition].filter(Boolean).join(":");
    if (key) {
      return `dd-${key}`;
    }
  }
  return `datadog-${Date.now().toString(36)}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function recordDatadogAttempt(body: string, status: Delivery["status"]): void {
  recordDelivery({
    id: `datadog-${Date.now().toString(36)}`,
    event: "datadog:alert",
    receivedAt: Date.now(),
    summary: "datadog",
    status,
    matched: [],
    payloadSnippet: body.slice(0, 2048),
  });
}
