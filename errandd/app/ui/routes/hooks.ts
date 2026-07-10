import { getHookQueue } from "../../hookQueue";
import {
  deliveryForWire,
  getDeliveryPayload,
  recentDeliveries,
  subscribeDeliveries,
} from "../../hooks/deliveries";
import { getWebhookSecret } from "../../hooks/receiver";
import { json } from "../http";
import { queueMessageForWire, type RouteHandler } from "./types";

/** GET /api/hooks/deliveries — recent deliveries (payload omitted). */
export const deliveriesList: RouteHandler = () =>
  json({ deliveries: recentDeliveries().map(deliveryForWire) });

// Full parsed payload for one delivery, fetched on demand (the list +
// SSE responses omit it to stay light). 404 once it ages out of the ring.
/** GET /api/hooks/deliveries/:id/payload. Returns null on no path/method match. */
export const deliveryPayload: RouteHandler = ({ req, url }) => {
  const m = /^\/api\/hooks\/deliveries\/([^/]+)\/payload$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const found = getDeliveryPayload(decodeURIComponent(m[1]));
    if (!found) {
      return json({ ok: false, error: "no stored payload" }, 404);
    }
    return json(found);
  }
  return null;
};

// Live delivery stream — pushes each delivery as it's recorded, matched,
// or skip-annotated, so the Deliveries tab updates in real time. Sends
// the current ring as an initial snapshot, then deltas keyed by id.
/** GET /api/hooks/events — live delivery SSE stream. */
export const hooksEvents: RouteHandler = ({ req, sseResponse }) =>
  sseResponse(req, (send) => {
    send({ type: "snapshot", deliveries: recentDeliveries().map(deliveryForWire) });
    return subscribeDeliveries((d) => send({ type: "delivery", delivery: deliveryForWire(d) }));
  });

// Durable hook queue — pending/running/recent messages, grouped by PR in
// the UI. Payload is omitted (heavy); the deliveries store has it.
/** GET /api/hooks/queue — durable queue snapshot. */
export const queueList: RouteHandler = () =>
  json({ messages: getHookQueue().listLatestPerThread(500).map(queueMessageForWire) });

// Re-arm finished hook-queue messages so the periodic drain (~3s) replays
// them. Body `{ ids: [...] }` retriggers those specific deliveries (failed OR
// done); an empty/absent body retriggers ALL failed messages ("retry every
// failure"). No agent runs inline here — requeue just flips status to pending.
/** POST /api/hooks/queue/retrigger — replay failed (or specified) deliveries. */
export const queueRetrigger: RouteHandler = async ({ req }) => {
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string")
    : undefined;
  const requeued = getHookQueue().requeue(ids);
  return json({ ok: true, requeued, ids: ids ?? "all-failed" });
};

// Live queue stream — pushes the full message list on every queue
// mutation (enqueue/claim/complete/defer), debounced 200ms.
/** GET /api/hooks/queue/events — live queue SSE stream. */
export const queueEvents: RouteHandler = ({ req, sseResponse }) =>
  sseResponse(req, (send) => {
    const snapshot = () =>
      send({
        type: "snapshot",
        messages: getHookQueue().listLatestPerThread(500).map(queueMessageForWire),
      });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        snapshot();
      }, 200);
    };
    snapshot();
    const unsubscribe = getHookQueue().subscribe(debounced);
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribe();
    };
  });

/** GET /api/hooks/triggers — flattened (job, pr-rule) rows for the table. */
export const triggers: RouteHandler = ({ opts }) => {
  // Flatten one row per (job, pr-rule) so the UI can render a table.
  const jobs = opts.getSnapshot().jobs;
  const rows: {
    job: string;
    agent: string | null;
    repo: string | string[];
    user: string[];
    action: string[];
    branch: string[];
    labels: string[];
    draft: boolean | "any";
  }[] = [];
  for (const job of jobs) {
    for (const rule of job.hookConfig?.pr ?? []) {
      rows.push({
        job: job.name,
        agent: job.agent ?? null,
        repo: rule.repo,
        user: rule.user,
        action: rule.action,
        branch: rule.branch,
        labels: rule.labels,
        draft: rule.draft,
      });
    }
  }
  return json({ triggers: rows });
};

/** GET /api/hooks/receiver — per-provider webhook receiver status + secrets. */
export const receiver: RouteHandler = async ({ url }) => {
  // The UI is gated by the bearer token so callers already have full
  // daemon access — same threat model as the web token itself.
  // Returning the raw secret enables a "click to reveal" affordance.
  const secret = getWebhookSecret();
  const last = recentDeliveries()[0] ?? null;
  const { getSentrySecret } = await import("../../hooks/sentry");
  const { getDatadogSecret, RECOMMENDED_DATADOG_PAYLOAD } = await import("../../hooks/datadog");
  const { getLinearSecret, getLinearBotMention } = await import("../../hooks/linear");
  const sentrySecret = getSentrySecret();
  const datadogSecret = getDatadogSecret();
  const linearSecret = getLinearSecret();
  return json({
    // Back-compat top-level fields describe the GitHub receiver.
    configured: secret.length > 0,
    secret,
    url: `${url.origin}/api/webhooks/github`,
    lastEventAt: last?.receivedAt ?? null,
    lastEvent: last?.event ?? null,
    // Per-provider receiver status for the multi-provider UI.
    providers: {
      github: {
        configured: secret.length > 0,
        secret,
        url: `${url.origin}/api/webhooks/github`,
        secretEnv: "ERRANDD_GITHUB_WEBHOOK_SECRET",
      },
      sentry: {
        configured: sentrySecret.length > 0,
        secret: sentrySecret,
        url: `${url.origin}/api/webhooks/sentry`,
        secretEnv: "ERRANDD_SENTRY_CLIENT_SECRET",
      },
      datadog: {
        configured: datadogSecret.length > 0,
        secret: datadogSecret,
        url: `${url.origin}/api/webhooks/datadog`,
        secretEnv: "ERRANDD_DATADOG_WEBHOOK_SECRET",
        // Datadog auth rides as ?token= or X-Errandd-Token, and the
        // payload is user-defined — surface both the token-in-URL form
        // and the recommended payload template for copy-paste.
        tokenUrl: datadogSecret
          ? `${url.origin}/api/webhooks/datadog?token=${encodeURIComponent(datadogSecret)}`
          : `${url.origin}/api/webhooks/datadog`,
        recommendedPayload: RECOMMENDED_DATADOG_PAYLOAD,
      },
      linear: {
        configured: linearSecret.length > 0,
        secret: linearSecret,
        url: `${url.origin}/api/webhooks/linear`,
        // Linear provides the signing secret when you create the webhook.
        secretEnv: "ERRANDD_LINEAR_WEBHOOK_SECRET",
        // The @mention gate (default-on) looks for this handle in ticket/comment text.
        botMention: getLinearBotMention(),
        botMentionEnv: "ERRANDD_LINEAR_BOT_MENTION",
      },
    },
  });
};
