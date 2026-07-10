import { createHmac, timingSafeEqual } from "node:crypto";
import type { Job } from "../jobs";
import {
  attachDeliveryPayload,
  type Delivery,
  type DeliveryRoutine,
  recordDelivery,
  setDeliveryEvaluation,
  summarize,
} from "./deliveries";
import { extractHookFields, extractHookKeys, extractHookPk } from "./evaluate";
import {
  CHECK_EVENTS,
  CLAW_IGNORE_SKIP_REASON,
  checksRuleSkipReason,
  extractHookScope,
  hasClawIgnoreLabel,
  matchChecksRule,
  matchIssuesRule,
  matchPatternList,
  matchPrRule,
  matchReviewRule,
  prRuleSkipReason,
  readChecksPayload,
  readIssuesPayload,
  issuesRuleSkipReason,
  readPrPayload,
  readReviewPayload,
  reviewRuleSkipReason,
} from "./match";
import { defaultChecksRule, defaultIssuesRule, defaultReviewRule } from "./schema";
import { prefilterReason } from "../../shared/hookEssentials";

/**
 * GitHub webhook receiver. Verifies HMAC-SHA256 signature using a secret
 * pulled from the ERRANDD_GITHUB_WEBHOOK_SECRET env var, records the
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
  /** Fire-and-forget callback for each matched (job, delivery) pair. `opts.notBefore`
   *  (epoch ms) defers the enqueued message so a debounced herd coalesces before
   *  it runs; omitted/0 = enqueue ready-now. */
  onHookFire?: (
    jobName: string,
    event: string,
    deliveryId: string,
    payload: unknown,
    opts?: { notBefore?: number },
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
    /** True when this is a PREFILTER drop (bot-noise / non-actionable) — the
     *  delivery never reaches the model. Drives the `[skip:fyi]` marker +
     *  blue "not in context" chat treatment. */
    prefilter?: boolean,
  ) => Promise<void> | void;
  /** Returns whether a session thread already exists for `threadId`. Used by a
   *  `checks` rule with `requireActiveThread` so CI events only re-wake a PR a
   *  routine already adopted (mechanical, local session-store lookup). When
   *  unset, `requireActiveThread` rules fall through to firing (feature unwired). */
  hasActiveThread?: (threadId: string) => boolean | Promise<boolean>;
}

export function getWebhookSecret(): string {
  return process.env.ERRANDD_GITHUB_WEBHOOK_SECRET ?? "";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear pipeline (auth → parse → record → match); breaking up obscures the flow.
export async function handleWebhook(req: Request, deps: WebhookDeps = {}): Promise<ReceiverResult> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return { status: 415, body: { ok: false, error: "json required" } };
  }

  const rawBody = await req.text();

  // Signature verification is OPT-IN. When ERRANDD_GITHUB_WEBHOOK_SECRET
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

  // Early-drop non-actionable CI noise. A check_run / check_suite / workflow_run
  // that hasn't COMPLETED carries no conclusion, so it can never match a `checks`
  // rule (the conclusion filter requires a terminal state). These fire ~2-3× per
  // workflow per push (requested / in_progress) — on an active monorepo that's a
  // flood (~hundreds/hr) that would otherwise be recorded into the delivery ring,
  // dispatched across every routine, and SSE-broadcast to every open dashboard
  // tab, all to produce a skip. Drop them here, before any of that work — the
  // single biggest lever against receiver/dashboard load under heavy CI.
  if (CHECK_EVENTS.has(event)) {
    const action = (payload as { action?: unknown } | null)?.action;
    if (action !== "completed") {
      return { status: 200, body: { ok: true } };
    }
  }

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

/** Placeholder "routine" name for the delivery-level skip recorded when an
 *  event matched no rule type / no subscribed routine — so the Deliveries
 *  table shows a reason instead of a blank outcome (the row isn't tied to a
 *  real job). */
const NO_ROUTINE_SENTINEL = "(no routine)";

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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the two event branches each fan out to fire/skip with reasons; splitting them loses the shared self-skip/actor context.
export async function dispatchHook(
  event: string,
  payload: unknown,
  id: string,
  deps: WebhookDeps,
): Promise<string[]> {
  const matched: string[] = [];
  // Structured per-routine outcomes recorded onto the delivery so the
  // deliveries table can show trigger/skip + reason without re-running match.
  const routines: DeliveryRoutine[] = [];
  if (!(deps.getJobs && deps.onHookFire)) {
    return matched;
  }
  const jobs = await deps.getJobs();
  // "Self" is the GitHub login the errandd user authenticates as; events
  // whose actor matches self are dropped (skipSelf default true) so a routine
  // doesn't retrigger on its own PRs / comments.
  const selfLogin = await getSelfLogin();
  const senderLogin = readSenderLogin(payload);
  const isSelfActor =
    !!selfLogin && !!senderLogin && senderLogin.toLowerCase() === selfLogin.toLowerCase();
  // When the bot authored the triggering post, its routine marker (stamped at
  // the top of the body) names WHICH routine. Self-skip then applies only to
  // that routine — a sibling routine can still act on it (subject to its own
  // user filter, which excludes bots by default). With NO marker we fail safe:
  // treat it as self for EVERY routine (the pre-marker, account-level behavior),
  // so a routine that forgets its marker can never start replying to itself.
  const selfMarkerRoutine = isSelfActor ? parseRoutineMarker(readTriggerBody(event, payload)) : null;
  const isSelfForJob = (jobName: string): boolean =>
    isSelfActor && (selfMarkerRoutine === null || selfMarkerRoutine === jobName);
  const selfSkipReason = (actor: string) =>
    selfMarkerRoutine
      ? `\`${selfMarkerRoutine}\` posted this itself (self-skip)`
      : `triggered by \`${actor || "?"}\` (this errandd user — self-skip)`;

  // A `claw:ignore` label on the PR pauses ALL hooks for it (PR events +
  // comments), independent of routine config — a human flips it to make the bot
  // leave a PR alone. Highest-priority skip, marked `ignore` in the table.
  const ignored = hasClawIgnoreLabel(event, payload);
  const IGNORE_REASON = CLAW_IGNORE_SKIP_REASON;

  if (event === "pull_request") {
    const pr = readPrPayload(payload);
    if (pr) {
      for (const job of jobs) {
        const rules = job.hookConfig?.pr ?? [];
        if (rules.length === 0) {
          continue; // not interested in PR events
        }
        if (ignored) {
          routines.push({ job: job.name, outcome: "skip", reason: IGNORE_REASON });
          void deps.onHookSkip?.(job.name, event, id, payload, IGNORE_REASON);
        } else if (job.hookConfig?.skipSelf !== false && isSelfForJob(job.name)) {
          const reason = selfSkipReason(senderLogin ?? "");
          routines.push({ job: job.name, outcome: "skip", reason });
          void deps.onHookSkip?.(job.name, event, id, payload, reason);
        } else if (rules.some((r) => matchPrRule(r, pr))) {
          matched.push(job.name);
          routines.push({ job: job.name, outcome: "trigger" });
          void deps.onHookFire(job.name, event, id, payload);
        } else {
          const reason = prRuleSkipReason(rules, pr);
          routines.push({ job: job.name, outcome: "skip", reason });
          void deps.onHookSkip?.(job.name, event, id, payload, reason);
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
    // A `pull_request_review` event prefers a job's `reviews:` rule (state +
    // reviewer filter) over its `comments:` rule. issue_comment and
    // pull_request_review_comment never have a reviews rule and always go
    // through the comments path below.
    const reviewPayload = event === "pull_request_review" ? readReviewPayload(payload) : null;
    // Loop guard (per thread): a errandd-authored comment that fires a sibling
    // routine consumes one hop; an external comment resets the budget. Decided
    // once per delivery so multiple firing routines still count as a single hop.
    const scope = extractHookScope(event, payload);
    const now = Date.now();
    const internalOverBudget = isSelfActor && !underHopBudget(scope, now);
    const loopGuardReason = `cross-routine loop guard — \`${scope ?? "?"}\` hit ${INTERNAL_HOP_MAX} errandd-authored triggers within ${INTERNAL_HOP_WINDOW_MS / 60000}m; pausing until an external comment or the window resets`;
    let commentFired = false;
    for (const job of jobs) {
      const reviewsCfg = job.hookConfig?.reviews;
      if (reviewPayload && reviewsCfg !== undefined && reviewsCfg !== false) {
        const rule = reviewsCfg === true ? defaultReviewRule() : reviewsCfg;
        if (ignored) {
          routines.push({ job: job.name, outcome: "skip", reason: IGNORE_REASON });
          void deps.onHookSkip?.(job.name, event, id, payload, IGNORE_REASON);
        } else if (job.hookConfig?.skipSelf !== false && isSelfForJob(job.name)) {
          const reason = selfSkipReason(actor ?? "");
          routines.push({ job: job.name, outcome: "skip", reason });
          void deps.onHookSkip?.(job.name, event, id, payload, reason);
        } else if (matchReviewRule(rule, reviewPayload)) {
          if (isSelfActor && internalOverBudget) {
            routines.push({ job: job.name, outcome: "skip", reason: loopGuardReason });
            void deps.onHookSkip?.(job.name, event, id, payload, loopGuardReason);
          } else {
            matched.push(job.name);
            routines.push({ job: job.name, outcome: "trigger" });
            void deps.onHookFire(job.name, event, id, payload);
            commentFired = true;
          }
        } else {
          const reason = reviewRuleSkipReason(rule, reviewPayload);
          routines.push({ job: job.name, outcome: "skip", reason });
          void deps.onHookSkip?.(job.name, event, id, payload, reason);
        }
        continue;
      }
      const cfg = job.hookConfig?.comments;
      if (cfg === undefined || cfg === false) {
        continue; // not interested
      }
      // `true` = any commenter (incl. bots — an explicit opt-in); an object
      // filters by glob. Compute the allowlist up front so the narrowing is
      // clean for both the fire decision and the bot-noise prefilter.
      const allowlist = cfg === true ? undefined : cfg.user;
      const wouldFire = cfg === true || (!!actor && matchPatternList(allowlist ?? [], actor));
      // Bot-noise prefilter: only when the actor is a bot the config would NOT
      // fire on anyway (an explicitly-allowed/triggering bot is never dropped —
      // don't break Greptile-as-trigger setups). It RELABELS the would-be
      // "not matched" skip as a prefilter `[skip:fyi]` drop so the chat
      // blue-boxes the suppressed bot body rather than showing a plain skip.
      const noiseReason = wouldFire ? null : prefilterReason(event, payload, allowlist);
      if (ignored) {
        routines.push({ job: job.name, outcome: "skip", reason: IGNORE_REASON });
        void deps.onHookSkip?.(job.name, event, id, payload, IGNORE_REASON);
      } else if (job.hookConfig?.skipSelf !== false && isSelfForJob(job.name)) {
        const reason = selfSkipReason(actor ?? "");
        routines.push({ job: job.name, outcome: "skip", reason });
        void deps.onHookSkip?.(job.name, event, id, payload, reason);
      } else if (wouldFire) {
        if (isSelfActor && internalOverBudget) {
          routines.push({ job: job.name, outcome: "skip", reason: loopGuardReason });
          void deps.onHookSkip?.(job.name, event, id, payload, loopGuardReason);
        } else {
          matched.push(job.name);
          routines.push({ job: job.name, outcome: "trigger" });
          void deps.onHookFire(job.name, event, id, payload);
          commentFired = true;
        }
      } else if (noiseReason) {
        // Bot-noise drop: recorded as a PREFILTER skip (dropped before the
        // model ever sees it), distinct from a plain config-rule skip.
        routines.push({ job: job.name, outcome: "skip", reason: noiseReason, prefilter: true });
        void deps.onHookSkip?.(job.name, event, id, payload, noiseReason, true);
      } else {
        const reason = `comment actor \`${actor ?? "?"}\` not matched by the comment user filter`;
        routines.push({ job: job.name, outcome: "skip", reason });
        void deps.onHookSkip?.(job.name, event, id, payload, reason);
      }
    }
    // One hop per delivery (counted after the loop so N firing routines = 1 hop).
    // An external trigger that fired clears the thread's budget.
    if (commentFired) {
      if (isSelfActor) {
        commitInternalHop(scope, now);
      } else {
        resetInternalHops(scope);
      }
    }
  } else if (CHECK_EVENTS.has(event)) {
    // CI/check webhooks (check_run / check_suite / workflow_run / workflow_job)
    // fire on the `checks` config (conclusion / branch / name filter).
    const cp = readChecksPayload(event, payload);
    if (cp) {
      for (const job of jobs) {
        const rule = job.hookConfig?.checks;
        if (rule === undefined || rule === false) {
          continue; // not interested in CI events
        }
        // `true` resolves to the bad-CI default (parseChecks normalizes it, but
        // guard here too so a programmatic `true` can't fire on every green run).
        const effective = rule === true ? defaultChecksRule() : rule;
        if (job.hookConfig?.skipSelf !== false && isSelfActor) {
          const reason = selfSkipReason(senderLogin ?? "");
          routines.push({ job: job.name, outcome: "skip", reason });
          void deps.onHookSkip?.(job.name, event, id, payload, reason);
        } else if (matchChecksRule(effective, cp)) {
          // Thread-gate: when requireActiveThread is set, only fire if a session
          // for this PR's thread already exists — CI events re-wake an existing
          // loop (e.g. pr-babysit on a `claw:babysit` PR) rather than waking the
          // routine on every PR's CI. The check scope is `pr-<n>` (same as the
          // PR's own events), so the threadId matches the adopted session's.
          let gated = false;
          if (effective.requireActiveThread && deps.hasActiveThread) {
            const scope = extractHookScope(event, payload);
            const base = job.agent ? `agent:${job.agent}` : job.name;
            const threadId = scope ? `${base}:hook:${scope}` : null;
            const active = threadId ? await deps.hasActiveThread(threadId) : false;
            if (!active) {
              gated = true;
              const reason = `no active \`${job.name}\` thread for this PR — checks only re-wake an existing loop (requireActiveThread)`;
              routines.push({ job: job.name, outcome: "skip", reason });
              void deps.onHookSkip?.(job.name, event, id, payload, reason);
            }
          }
          if (!gated) {
            matched.push(job.name);
            routines.push({ job: job.name, outcome: "trigger" });
            void deps.onHookFire(job.name, event, id, payload);
          }
        } else {
          const reason = checksRuleSkipReason(effective, cp);
          routines.push({ job: job.name, outcome: "skip", reason });
          void deps.onHookSkip?.(job.name, event, id, payload, reason);
        }
      }
    }
  } else if (event === "issues") {
    // The plain `issues` event (opened/closed/labeled/…) — distinct from
    // issue_comment (which is a COMMENT_EVENT). Fires on the `issues` config.
    const ip = readIssuesPayload(payload);
    if (ip) {
      for (const job of jobs) {
        const rule = job.hookConfig?.issues;
        if (rule === undefined || rule === false) {
          continue; // not interested in issue lifecycle events
        }
        const effective = rule === true ? defaultIssuesRule() : rule;
        if (job.hookConfig?.skipSelf !== false && isSelfForJob(job.name)) {
          const reason = selfSkipReason(senderLogin ?? "");
          routines.push({ job: job.name, outcome: "skip", reason });
          void deps.onHookSkip?.(job.name, event, id, payload, reason);
        } else if (matchIssuesRule(effective, ip)) {
          matched.push(job.name);
          routines.push({ job: job.name, outcome: "trigger" });
          void deps.onHookFire(job.name, event, id, payload);
        } else {
          const reason = issuesRuleSkipReason(effective, ip);
          routines.push({ job: job.name, outcome: "skip", reason });
          void deps.onHookSkip?.(job.name, event, id, payload, reason);
        }
      }
    }
  }

  // No silent drops: any GitHub event that produced no per-routine outcome —
  // either an event class with no rule type at all (push, release, …) or a
  // known event no loaded routine subscribes to — records ONE delivery-level
  // skip so the Deliveries table explains itself instead of showing a blank
  // outcome. `ping` is acknowledged quietly (no jobs, no noise).
  if (routines.length === 0 && event !== "ping" && !event.includes(":")) {
    routines.push({
      job: NO_ROUTINE_SENTINEL,
      outcome: "skip",
      reason: `event type \`${event}\` has no matching rule`,
    });
  }

  // Record the extracted fields + per-routine outcomes onto the live delivery
  // (best-effort; a no-op on reprocess when the ring entry has aged out).
  attachDeliveryPayload(id, payload);
  setDeliveryEvaluation(id, {
    source: "github",
    pk: extractHookPk(event, payload),
    keys: extractHookKeys(event, payload),
    fields: extractHookFields(event, payload),
    routines,
  });
  return matched;
}

/**
 * Verifies that `sigHeader` (`sha256=<hex>`) is a valid HMAC-SHA256 of
 * `body` under `secret`. Constant-time comparison.
 */
function verifySignature(secret: string, sigHeader: string, body: string): boolean {
  const match = /^sha256=([0-9a-f]+)$/i.exec(sigHeader);
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

/** The freeform text body the routine signs with its marker: the comment/review
 *  body, or the PR/issue body on open events. CI (`check_*`) events carry none. */
function readTriggerBody(event: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const key =
    event === "pull_request_review"
      ? "review"
      : event === "pull_request"
        ? "pull_request"
        : event === "issues"
          ? "issue"
          : "comment"; // issue_comment / pull_request_review_comment
  const node = root[key];
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const body = (node as Record<string, unknown>).body;
  return typeof body === "string" ? body : null;
}

/** Pull the authoring routine out of a errandd marker
 *  (`<!-- errandd:routine=<name> … -->`) stamped at the top of a GitHub post.
 *  Returns null when absent. Tolerant of extra fields after the name so the
 *  marker can carry more metadata later. */
const ROUTINE_MARKER_RE = /<!--\s*errandd:routine=([\w./-]+)/;
function parseRoutineMarker(body: string | null): string | null {
  if (!body) {
    return null;
  }
  return ROUTINE_MARKER_RE.exec(body)?.[1] ?? null;
}

// ── Cross-routine loop guard ────────────────────────────────────────────────
// The marker self-skip lets a routine act on a SIBLING routine's posts. Two
// routines that both accept bot comments could otherwise ping-pong forever. Bound
// the number of errandd-authored ("internal") comment triggers that may fire on
// a single PR/issue thread within a window; any external (human / third-party-bot)
// comment that fires resets the thread's budget. In-memory, best-effort (resets
// on restart) — a backstop, not exact accounting.
const INTERNAL_HOP_WINDOW_MS = 15 * 60 * 1000;
const INTERNAL_HOP_MAX = 6;
const internalHops = new Map<string, { count: number; windowStart: number }>();

function hopEntry(scope: string, now: number): { count: number; windowStart: number } {
  const e = internalHops.get(scope);
  if (!e || now - e.windowStart > INTERNAL_HOP_WINDOW_MS) {
    const fresh = { count: 0, windowStart: now };
    internalHops.set(scope, fresh);
    return fresh;
  }
  return e;
}
/** True while `scope` still has internal-hop budget this window. A null scope
 *  can't be tracked, so it's never blocked. Peek only (rolls an expired window). */
function underHopBudget(scope: string | null, now: number): boolean {
  return scope ? hopEntry(scope, now).count < INTERNAL_HOP_MAX : true;
}
/** Consume one internal hop — call once per delivery that actually fired a
 *  routine off a errandd-authored comment. */
function commitInternalHop(scope: string | null, now: number): void {
  if (scope) {
    hopEntry(scope, now).count += 1;
  }
}
/** An external (human/third-party) trigger breaks any ping-pong — clear budget. */
function resetInternalHops(scope: string | null): void {
  if (scope) {
    internalHops.delete(scope);
  }
}

/** Top-level `sender.login` — the GitHub account whose action produced
 *  the webhook delivery. Used as the self-skip check alongside the
 *  event-specific commenter login. */
function readSenderLogin(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const sender = (payload as Record<string, unknown>).sender;
  if (typeof sender !== "object" || sender === null) {
    return null;
  }
  const login = (sender as Record<string, unknown>).login;
  return typeof login === "string" ? login : null;
}

/**
 * Resolve errandd's own GitHub login. `ERRANDD_SELF_LOGIN` overrides
 * everything (explicit config for deployments where `gh` isn't on PATH, and the
 * seam tests use); otherwise `gh api user --jq .login`, cached for the process
 * lifetime (null if gh isn't auth'd / not on PATH, making skipSelf a no-op).
 *
 * Promise-cached so concurrent webhook deliveries don't race the lookup.
 */
let _selfLoginPromise: Promise<string | null> | null = null;
async function getSelfLogin(): Promise<string | null> {
  const override = process.env.ERRANDD_SELF_LOGIN?.trim();
  if (override) {
    return override;
  }
  if (_selfLoginPromise) {
    return _selfLoginPromise;
  }
  _selfLoginPromise = (async () => {
    try {
      const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) {
        return null;
      }
      const login = stdout.trim();
      return login.length > 0 ? login : null;
    } catch {
      return null;
    }
  })();
  return _selfLoginPromise;
}
