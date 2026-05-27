import { createHmac, timingSafeEqual } from "node:crypto";
import type { Job } from "../jobs";
import { type Delivery, recordDelivery, summarize } from "./deliveries";
import { matchPrRule, readPrPayload } from "./match";

/**
 * GitHub webhook receiver. Verifies HMAC-SHA256 signature using a secret
 * pulled from the CLAWDCODE_GITHUB_WEBHOOK_SECRET env var, records the
 * delivery in the ring buffer for inspection, and dispatches matching jobs.
 *
 * Follows https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */

export interface ReceiverResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; error?: string; matched?: string[] };
}

export interface WebhookDeps {
  /** Called fresh per delivery so newly-added hook config is picked up
   *  without a daemon restart. */
  getJobs?: () => Job[] | Promise<Job[]>;
  /** Fire-and-forget callback for each matched (job, delivery) pair. */
  onHookFire?: (
    jobName: string,
    event: string,
    deliveryId: string,
    payload: unknown,
  ) => Promise<void> | void;
}

export function getWebhookSecret(): string {
  return process.env.CLAWDCODE_GITHUB_WEBHOOK_SECRET ?? "";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear pipeline (auth → parse → record → match); breaking up obscures the flow.
export async function handleWebhook(req: Request, deps: WebhookDeps = {}): Promise<ReceiverResult> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return { status: 415, body: { ok: false, error: "json required" } };
  }

  const rawBody = await req.text();

  // Signature verification is OPT-IN. When CLAWDCODE_GITHUB_WEBHOOK_SECRET
  // is set we require a valid X-Hub-Signature-256; when unset we accept
  // deliveries as-is (useful for dev/testing; the receiver-status endpoint
  // surfaces which mode is active so the UI can warn).
  const secret = getWebhookSecret();
  if (secret) {
    const sigHeader = req.headers.get("x-hub-signature-256") ?? "";
    if (!verifySignature(secret, sigHeader, rawBody)) {
      recordAttempt(req, rawBody, "bad-signature");
      return { status: 401, body: { ok: false, error: "bad signature" } };
    }
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    recordAttempt(req, rawBody, "error");
    return { status: 400, body: { ok: false, error: "invalid json" } };
  }

  const event = req.headers.get("x-github-event") ?? "unknown";
  const id = req.headers.get("x-github-delivery") ?? `local-${Date.now().toString(36)}`;

  const delivery: Delivery = {
    id,
    event,
    receivedAt: Date.now(),
    summary: summarize(event, payload),
    status: "ok",
    matched: [],
    payloadSnippet: rawBody.slice(0, 2048),
  };

  const fresh = recordDelivery(delivery);
  if (!fresh) {
    delivery.status = "duplicate";
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  // Matcher: only `pull_request` is wired in v1.
  if (event === "pull_request" && deps.getJobs && deps.onHookFire) {
    const pr = readPrPayload(payload);
    if (pr) {
      try {
        const jobs = await deps.getJobs();
        for (const job of jobs) {
          const rules = job.hookConfig?.pr ?? [];
          if (rules.some((r) => matchPrRule(r, pr))) {
            delivery.matched.push(job.name);
            // Fire without awaiting — webhook responds quickly; runs happen async.
            void deps.onHookFire(job.name, event, id, payload);
          }
        }
      } catch (err) {
        // Don't fail the webhook just because matching errored; log via stderr.
        console.error("[hooks] matcher error:", err);
      }
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      ...(delivery.matched.length > 0 ? { matched: delivery.matched } : {}),
    },
  };
}

/**
 * Verifies that `sigHeader` (`sha256=<hex>`) is a valid HMAC-SHA256 of
 * `body` under `secret`. Constant-time comparison.
 */
function verifySignature(secret: string, sigHeader: string, body: string): boolean {
  const match = sigHeader.match(/^sha256=([0-9a-f]+)$/i);
  if (!match?.[1]) {
    return false;
  }
  const provided = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

function recordAttempt(req: Request, body: string, status: Delivery["status"]): void {
  const event = req.headers.get("x-github-event") ?? "unknown";
  const id = req.headers.get("x-github-delivery") ?? `local-${Date.now().toString(36)}`;
  let payload: unknown = null;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    // ignore — we still want a record of the attempt
  }
  recordDelivery({
    id,
    event,
    receivedAt: Date.now(),
    summary: summarize(event, payload),
    status,
    matched: [],
    payloadSnippet: body.slice(0, 2048),
  });
}
