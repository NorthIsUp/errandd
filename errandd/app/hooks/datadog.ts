import type { Delivery, DeliveryRoutine } from "./deliveries";
import { recordDelivery } from "./deliveries";
import { datadogRuleSkipReason, matchDatadogRule, readDatadogPayload } from "./match";
import type { ReceiverResult, WebhookDeps } from "./receiver";
import { defaultDatadogRule } from "./schema";
import { handleSignedWebhook, type WebhookSpec } from "./webhookEnvelope";

/**
 * Datadog webhook receiver.
 *
 * https://docs.datadoghq.com/integrations/webhooks/
 *
 * Datadog webhooks are NOT HMAC-signed — the payload is fully user-defined.
 * errandd authenticates with a shared token: the value of
 * ERRANDD_DATADOG_WEBHOOK_SECRET must arrive either as the
 * `X-Errandd-Token` header or a `?token=` query param. When the secret is
 * unset, deliveries are accepted as-is (dev/testing).
 *
 * Because the payload shape is user-controlled, errandd recommends a
 * canonical webhook payload template in the Datadog integration config
 * (see RECOMMENDED_DATADOG_PAYLOAD). Matching keys off those field names.
 *
 * The content-type guard, token auth, dedup, and evaluation recording are the
 * shared `handleSignedWebhook` pipeline; only the id/summary derivation and the
 * match body are Datadog-specific (passed as the `WebhookSpec`).
 */

export function getDatadogSecret(): string {
  return process.env.ERRANDD_DATADOG_WEBHOOK_SECRET ?? "";
}

/** The payload template errandd recommends pasting into the Datadog
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

export function handleDatadogWebhook(
  req: Request,
  deps: WebhookDeps = {},
): Promise<ReceiverResult> {
  const spec: WebhookSpec = {
    source: "datadog",
    // Datadog payloads are not HMAC-signed — shared-token auth (header or
    // ?token= query param). Unset secret ⇒ accept as-is (dev/testing).
    auth: { kind: "token", header: "x-errandd-token", secret: getDatadogSecret() },
    deriveIdentity: (_req, payload) => {
      const dp = readDatadogPayload(payload);
      const summary = [
        "datadog",
        dp?.type || null,
        dp?.priority || null,
        dp?.monitor ? `monitor=${dp.monitor}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        event: "datadog:alert",
        // Datadog has no delivery id header. Use aggreg_key + transition so a
        // re-alert and its recovery dedup independently but a duplicate POST of
        // the same transition collapses.
        id: deriveDatadogId(payload),
        summary,
      };
    },
    match: ({ payload, identity, delivery, deps: d }) =>
      matchDatadog(payload, identity.event, identity.id, delivery, d),
    recordAttempt: (_req, body, status) => recordDatadogAttempt(body, status),
  };
  return handleSignedWebhook(req, deps, spec);
}

/** Per-job Datadog match pass. Mirrors the other receivers: a `true` rule
 *  resolves to the priority-floor default, matched jobs fire (and land in
 *  `delivery.matched`), the rest record a skip with a reason. */
async function matchDatadog(
  payload: unknown,
  event: string,
  id: string,
  delivery: Delivery,
  deps: WebhookDeps,
): Promise<DeliveryRoutine[]> {
  const routines: DeliveryRoutine[] = [];
  const dp = readDatadogPayload(payload);
  if (deps.getJobs && deps.onHookFire && dp) {
    try {
      const jobs = await deps.getJobs();
      for (const job of jobs) {
        const rule = job.hookConfig?.datadog;
        if (!rule) {
          continue;
        }
        // `true` resolves to the priority-floor default (parseDatadog normalizes
        // it, but guard here too so a programmatic `true` can't fire on every
        // alert — denial-of-wallet, P0-4). Mirrors the Sentry receiver.
        const effective = rule === true ? defaultDatadogRule() : rule;
        if (matchDatadogRule(effective, dp)) {
          delivery.matched.push(job.name);
          routines.push({ job: job.name, outcome: "trigger" });
          void deps.onHookFire(job.name, event, id, payload);
        } else {
          routines.push({
            job: job.name,
            outcome: "skip",
            reason: datadogRuleSkipReason(effective, dp),
          });
        }
      }
    } catch (err) {
      console.error("[hooks:datadog] matcher error:", err);
    }
  }
  return routines;
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
