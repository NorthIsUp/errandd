import { type Delivery, type DeliveryRoutine, recordDelivery } from "./deliveries";
import {
  extractHookPk,
  sentryExtractFields,
  sentryExtractKeys,
  sentryExtractPk,
} from "./evaluate";
import { matchSentryRule, readSentryPayload, sentryRuleSkipReason } from "./match";
import type { ReceiverResult, WebhookDeps } from "./receiver";
import { defaultSentryRule, parseSentryTrigger, type SentryRule } from "./schema";
import { markIssueSeen, releaseIssueSeen } from "./sentrySeen";
import type { ProviderStatus, SourcePlugin } from "./sources";
import { handleSignedWebhook, type WebhookSpec } from "./webhookEnvelope";

/**
 * Sentry integration-platform webhook receiver.
 *
 * https://docs.sentry.io/integrations/integration-platform/webhooks/
 *
 * - Verifies `Sentry-Hook-Signature` (HMAC-SHA256 of the raw body using the
 *   integration Client Secret in ERRANDD_SENTRY_CLIENT_SECRET). When the
 *   secret is unset, deliveries are accepted as-is (dev/testing).
 * - Dedups on the `Request-ID` header.
 * - The resource type comes from `Sentry-Hook-Resource` (issue, error,
 *   event_alert, metric_alert, comment, …) and is threaded to jobs as the
 *   event `sentry:<resource>`.
 *
 * The content-type guard, HMAC auth, dedup, and evaluation recording are the
 * shared `handleSignedWebhook` pipeline; the Sentry-specific parts (the
 * `sentry-hook-resource` header → event/summary derivation, and the stateful
 * first-seen / debounce gate between match and enqueue) live in the
 * `WebhookSpec` callbacks below.
 */

export function getSentrySecret(): string {
  return process.env.ERRANDD_SENTRY_CLIENT_SECRET ?? "";
}

/** The `sentry-hook-resource` header value, defaulting to `event`. The single
 *  source for the resource across deriveIdentity + the matcher (so the
 *  authoritative header resource — not the body-shape inference — drives both
 *  the event label and the type filter). */
function resourceOf(event: string): string {
  // event is `sentry:<resource>`; strip the prefix back to the resource.
  return event.slice("sentry:".length) || "event";
}

/** Build the per-request Sentry webhook spec (reads the secret fresh from env). */
function buildSentrySpec(): WebhookSpec {
  const spec: WebhookSpec = {
    source: "sentry",
    auth: { kind: "hmac", header: "sentry-hook-signature", secret: getSentrySecret(),
      required: process.env.NODE_ENV !== "test" && (process.env.NODE_ENV === "production" || Boolean((process.env.SENTRY_AUTH_TOKEN || process.env.SENTRY_ACCESS_TOKEN) && process.env.SENTRY_ORG)),
    },
    deriveIdentity: (req2, payload) => {
      const resource = req2.headers.get("sentry-hook-resource") ?? "event";
      const sp = readSentryPayload(payload);
      // The `sentry-hook-resource` header is the authoritative resource type —
      // use it over the body-shape inference so the type filter is exact.
      if (sp && resource !== "event") {
        sp.resource = resource;
      }
      const summary = [
        "sentry",
        resource,
        sp?.action || null,
        sp?.project ? `project=${sp.project}` : null,
        sp?.level || null,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        event: `sentry:${resource}`,
        id: req2.headers.get("request-id") ?? `sentry-${Date.now().toString(36)}`,
        summary,
      };
    },
    match: ({ payload, identity, delivery, deps: d }) =>
      dispatchSentryAlert(payload, identity.event, identity.id, delivery, d),
    recordAttempt: (req2, body, status) => recordSentryAttempt(req2, body, status),
  };
  return spec;
}

/** Sentry webhook receiver — back-compat wrapper over the shared envelope. */
export function handleSentryWebhook(
  req: Request,
  deps: WebhookDeps = {},
): Promise<ReceiverResult> {
  return handleSignedWebhook(req, deps, buildSentrySpec());
}

/** Per-provider receiver status for the Settings UI. */
function sentryProviderStatus(origin: string): ProviderStatus {
  const secret = getSentrySecret();
  return {
    configured: secret.length > 0,
    secret,
    url: `${origin}/api/webhooks/sentry`,
    secretEnv: "ERRANDD_SENTRY_CLIENT_SECRET",
  };
}

/** The Sentry inbound SOURCE plugin. */
export const sentrySource: SourcePlugin = {
  id: "sentry",
  routePath: "/api/webhooks/sentry",
  aliasPath: "/api/sentry/webhook",
  webhookSpec: buildSentrySpec,
  ownsEvent: (event: string) => event.startsWith("sentry:"),
  extractFields: sentryExtractFields,
  extractKeys: sentryExtractKeys,
  extractPk: sentryExtractPk,
  configKeys: ["sentry"],
  parseRule: parseSentryTrigger,
  providerStatus: sentryProviderStatus,
};

/**
 * Per-job Sentry match pass + the stateful first-seen / debounce gate.
 *
 * The pure matcher runs first (side-effect-free), collecting the jobs whose
 * rule matched and recording a skip for the rest. Then the stateful gates run:
 *  - first-seen is computed ONCE per delivery (not per job) so a single
 *    new-issue delivery wakes ALL first-seen jobs on its first occurrence;
 *  - debounce defers the enqueue via `notBefore` so a thundering herd for one
 *    issue gathers into the coalesced thread before the worker drains it.
 */
export async function dispatchSentryAlert(
  payload: unknown,
  event: string,
  id: string,
  delivery: Delivery,
  deps: WebhookDeps,
  throwOnError = false,
): Promise<DeliveryRoutine[]> {
  const routines: DeliveryRoutine[] = [];
  const resource = resourceOf(event);
  const sp = readSentryPayload(payload);
  if (sp && resource !== "event") {
    sp.resource = resource;
  }
  if (deps.getJobs && deps.onHookFire && sp) {
    let claimedIssue: string | undefined;
    try {
      const jobs = await deps.getJobs();
      // Pure match pass first: collect the jobs whose rule matched (and record a
      // skip for the rest). The stateful first-seen / debounce gates run after,
      // so the pure matcher stays side-effect-free.
      const matched: { name: string; rule: SentryRule }[] = [];
      for (const job of jobs) {
        const rule = job.hookConfig?.sentry;
        if (!rule) {
          continue;
        }
        // `true` resolves to the prod-only default (parseSentry normalizes it,
        // but guard here too so a programmatic `true` can't match all projects).
        const effective = rule === true ? defaultSentryRule() : rule;
        if (matchSentryRule(effective, sp)) {
          matched.push({ name: job.name, rule: effective });
        } else {
          routines.push({
            job: job.name,
            outcome: "skip",
            reason: sentryRuleSkipReason(effective, sp),
          });
        }
      }

      // First-seen gate, computed ONCE per delivery (not per job). Rationale:
      // a single new-issue delivery may match multiple first-seen jobs; ALL of
      // them should run on that first occurrence. So we flip the persistent
      // "seen" bit a single time for the whole delivery and gate every
      // first-seen job on that one boolean — rather than letting the first job
      // consume the flag and starve the others. The atomic insert in
      // markIssueSeen is the singleflight across a burst: exactly one delivery
      // (the one that wins the INSERT) gets isFirstSeen=true.
      const issueId = extractHookPk(event, payload);
      const anyFirstSeen = matched.some((m) => m.rule.firstSeen);
      // Only consult the ledger when a matched rule actually asks for it, and
      // only when we have an issue id (a payload with no issue id can't be
      // deduped — treat it as not-gated rather than as a brand-new issue).
      const isFirstSeen =
        anyFirstSeen && issueId ? markIssueSeen(issueId).firstSeen : true;
      if (anyFirstSeen && issueId && isFirstSeen) claimedIssue = issueId;

      for (const m of matched) {
        if (m.rule.firstSeen && issueId && !isFirstSeen) {
          // Already triaged: don't re-enqueue. Record the skip the same way an
          // unmatched rule is recorded (a `skip` routine on the delivery).
          routines.push({
            job: m.name,
            outcome: "skip",
            reason: `issue ${issueId} already triaged (first-seen filter)`,
          });
          continue;
        }
        delivery.matched.push(m.name);
        routines.push({ job: m.name, outcome: "trigger" });
        // Debounce: defer the enqueue so a thundering herd for one issue gathers
        // into the (already issue-coalesced) thread before the worker drains it.
        const notBefore = m.rule.debounceMs > 0 ? Date.now() + m.rule.debounceMs : undefined;
        await deps.onHookFire(m.name, event, id, payload, notBefore ? { notBefore } : undefined);
      }
    } catch (err) {
      if (claimedIssue) releaseIssueSeen(claimedIssue);
      if (throwOnError) throw err;
      console.error("[hooks:sentry] matcher error:", err);
    }
  }
  return routines;
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
