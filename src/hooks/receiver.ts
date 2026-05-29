import { createHmac, timingSafeEqual } from "node:crypto";
import type { Job } from "../jobs";
import { type Delivery, recordDelivery, summarize } from "./deliveries";
import { matchPatternList, matchPrRule, prRuleSkipReason, readPrPayload } from "./match";

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
  /** Called when a job is interested in the event but its config filters
   *  the delivery out (self-skip, user/branch/etc.) — surfaces a skip row
   *  in the Runs view without spawning Claude. `reason` is human-readable. */
  onHookSkip?: (
    jobName: string,
    event: string,
    deliveryId: string,
    payload: unknown,
    reason: string,
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

  if (deps.getJobs && deps.onHookFire) {
    try {
      const matched = await dispatchHook(event, payload, id, deps);
      delivery.matched.push(...matched);
    } catch (err) {
      // Don't fail the webhook just because matching errored; log via stderr.
      console.error("[hooks] matcher error:", err);
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

const COMMENT_EVENTS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);

/**
 * Match a parsed webhook against the loaded jobs and dispatch fire/skip
 * callbacks. Shared by the live receiver and hook reprocessing. Returns the
 * job names that fired (not the skipped ones).
 *
 * Two paths:
 *  - `pull_request` events go through the per-rule matcher (repo/user/branch/…).
 *  - comment-class events fire on the `comments` config (true = any actor, or
 *    a user-glob filter), keyed on the `sender` (the actor / on-behalf-of).
 *
 * Self-skip and per-dimension filter rejections are surfaced via onHookSkip
 * so they appear as config-driven skip rows in Runs without spawning Claude.
 */
export async function dispatchHook(
  event: string,
  payload: unknown,
  id: string,
  deps: WebhookDeps,
): Promise<string[]> {
  const matched: string[] = [];
  if (!deps.getJobs || !deps.onHookFire) return matched;
  const jobs = await deps.getJobs();
  // "Self" is the GitHub login the clawdcode user authenticates as; events
  // whose actor matches self are dropped (skipSelf default true) so a routine
  // doesn't retrigger on its own PRs / comments.
  const selfLogin = await getSelfLogin();
  const senderLogin = readSenderLogin(payload);
  const isSelfActor =
    !!selfLogin && !!senderLogin && senderLogin.toLowerCase() === selfLogin.toLowerCase();
  const selfSkipReason = (actor: string) =>
    `triggered by \`${actor || "?"}\` (this clawdcode user — self-skip)`;

  if (event === "pull_request") {
    const pr = readPrPayload(payload);
    if (pr) {
      for (const job of jobs) {
        const rules = job.hookConfig?.pr ?? [];
        if (rules.length === 0) continue; // not interested in PR events
        if (job.hookConfig?.skipSelf !== false && isSelfActor) {
          void deps.onHookSkip?.(job.name, event, id, payload, selfSkipReason(senderLogin ?? ""));
        } else if (rules.some((r) => matchPrRule(r, pr))) {
          matched.push(job.name);
          void deps.onHookFire(job.name, event, id, payload);
        } else {
          void deps.onHookSkip?.(job.name, event, id, payload, prRuleSkipReason(rules, pr));
        }
      }
    }
  } else if (COMMENT_EVENTS.has(event)) {
    // The identity for comment matching + self-skip is the ACTOR — the
    // `sender` that triggered the delivery, i.e. who it's on behalf of. A
    // GitHub App authors comments as its own bot user (`comment.user`), but
    // `sender` is the real actor; keying off `comment.user` misclassifies a
    // human acting through an app (e.g. Graphite) as a bot.
    const actor = senderLogin;
    for (const job of jobs) {
      const cfg = job.hookConfig?.comments;
      if (cfg === undefined || cfg === false) continue; // not interested
      if (job.hookConfig?.skipSelf !== false && isSelfActor) {
        void deps.onHookSkip?.(job.name, event, id, payload, selfSkipReason(actor ?? ""));
      } else if (cfg === true || (actor && matchPatternList(cfg.user, actor))) {
        matched.push(job.name);
        void deps.onHookFire(job.name, event, id, payload);
      } else {
        void deps.onHookSkip?.(
          job.name,
          event,
          id,
          payload,
          `comment actor \`${actor ?? "?"}\` not matched by the comment user filter`,
        );
      }
    }
  }
  return matched;
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

/** Top-level `sender.login` — the GitHub account whose action produced
 *  the webhook delivery. Used as the self-skip check alongside the
 *  event-specific commenter login. */
function readSenderLogin(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const sender = (payload as Record<string, unknown>).sender;
  if (typeof sender !== "object" || sender === null) return null;
  const login = (sender as Record<string, unknown>).login;
  return typeof login === "string" ? login : null;
}

/**
 * Resolve clawdcode's own GitHub login via `gh api user --jq .login` and
 * cache it for the process lifetime. The first call shells out; later
 * calls return the cached value (or null if gh isn't auth'd / not on
 * PATH, in which case skipSelf becomes a no-op).
 *
 * Promise-cached so concurrent webhook deliveries don't race the lookup.
 */
let _selfLoginPromise: Promise<string | null> | null = null;
async function getSelfLogin(): Promise<string | null> {
  if (_selfLoginPromise) return _selfLoginPromise;
  _selfLoginPromise = (async () => {
    try {
      const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) return null;
      const login = stdout.trim();
      return login.length > 0 ? login : null;
    } catch {
      return null;
    }
  })();
  return _selfLoginPromise;
}
