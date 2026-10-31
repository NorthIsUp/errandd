import { prefilterReason } from "../../shared/hookEssentials";
import {
  attachDeliveryPayload,
  type Delivery,
  type DeliveryRoutine,
  recordDelivery,
  setDeliveryEvaluation,
  summarize,
} from "./deliveries";
import {
  githubExtractFields,
  githubExtractKeys,
  githubExtractPk,
} from "./evaluate";
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
import { recordPrStateFromWebhook } from "../pr-state";
import type { ReceiverResult, WebhookDeps } from "./receiver";
import {
  defaultChecksRule,
  defaultIssuesRule,
  defaultReviewRule,
  parseGithubTrigger,
} from "./schema";
import type { ProviderStatus, SourcePlugin } from "./sources";
import {
  type DeliveryIdentity,
  handleSignedWebhook,
  type WebhookSpec,
} from "./webhookEnvelope";

/**
 * GitHub webhook SOURCE plugin.
 *
 * GitHub used to bypass the shared `webhookEnvelope` with its own hand-rolled
 * `handleWebhook`; it now rides the SAME `handleSignedWebhook` pipeline as the
 * other providers. The only GitHub-specific pieces are expressed as envelope
 * hooks: HMAC auth with the `sha256=` prefix, header-based identity
 * (`x-github-event` / `x-github-delivery`), a `preRecord` early-drop for
 * non-terminal CI-check noise, and `dispatchHook` wired as the match callback
 * with `evaluate: "match"` (so `dispatchHook` — which only enriches when
 * `getJobs`/`onHookFire` deps are present — owns the evaluation recording).
 *
 * Signature scheme:
 *   https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */

export function getWebhookSecret(): string {
  return process.env.ERRANDD_GITHUB_WEBHOOK_SECRET ?? "";
}

/** The routine `on:` trigger keys owned by the GitHub source. */
const GITHUB_CONFIG_KEYS = ["prs", "pr", "comments", "reviews", "checks", "issues"] as const;

/** Build the per-request GitHub webhook spec (reads the secret fresh from env). */
function buildGithubSpec(): WebhookSpec {
  return {
    source: "github",
    // Signature verification is OPT-IN: an empty secret makes the envelope
    // accept deliveries as-is (dev/testing). GitHub signs the raw body as
    // `sha256=<hex>` in X-Hub-Signature-256.
    auth: {
      kind: "hmac",
      header: "x-hub-signature-256",
      secret: getWebhookSecret(),
      prefix: "sha256=",
    },
    deriveIdentity: (req, payload) => {
      const event = req.headers.get("x-github-event") ?? "unknown";
      return {
        event,
        id: req.headers.get("x-github-delivery") ?? `local-${Date.now().toString(36)}`,
        summary: summarize(event, payload),
      };
    },
    preRecord: (identity, payload) => githubPreRecordDrop(identity, payload),
    // GitHub fans out to `dispatchHook`, which pushes fired job names onto
    // `delivery.matched` and records its own evaluation. Return `[]` — with
    // `evaluate: "match"` the envelope records nothing on GitHub's behalf.
    match: async ({ payload, identity, delivery, deps }) => {
      if (deps.getJobs && deps.onHookFire) {
        try {
          const matched = await dispatchHook(identity.event, payload, identity.id, deps);
          delivery.matched.push(...matched);
        } catch (err) {
          // Don't fail the webhook just because matching errored; log via stderr.
          console.error("[hooks] matcher error:", err);
        }
      }
      return [];
    },
    evaluate: "match",
    recordAttempt: (req, body, status) => recordAttempt(req, body, status),
  };
}

/**
 * Early-drop non-actionable CI noise. A check_run / check_suite / workflow_run
 * that hasn't COMPLETED carries no conclusion, so it can never match a `checks`
 * rule (the conclusion filter requires a terminal state). These fire ~2-3× per
 * workflow per push (requested / in_progress) — on an active monorepo that's a
 * flood (~hundreds/hr) that would otherwise be recorded into the delivery ring,
 * dispatched across every routine, and SSE-broadcast to every open dashboard
 * tab, all to produce a skip. Drop them before any of that work — the single
 * biggest lever against receiver/dashboard load under heavy CI.
 */
function githubPreRecordDrop(identity: DeliveryIdentity, payload: unknown): ReceiverResult | null {
  if (CHECK_EVENTS.has(identity.event)) {
    const action = (payload as { action?: unknown } | null)?.action;
    if (action !== "completed") {
      return { status: 200, body: { ok: true } };
    }
  }
  return null;
}

/**
 * GitHub webhook receiver — thin back-compat wrapper over the shared envelope.
 * Verifies the HMAC signature (opt-in via ERRANDD_GITHUB_WEBHOOK_SECRET),
 * records the delivery, and dispatches matching jobs. Kept as a named export so
 * callers (server, tests) that imported `handleWebhook` keep working.
 */
export function handleWebhook(req: Request, deps: WebhookDeps = {}): Promise<ReceiverResult> {
  return handleSignedWebhook(req, deps, buildGithubSpec());
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

  // A `errandd:ignore` label on the PR pauses ALL hooks for it (PR events +
  // comments), independent of routine config — a human flips it to make the bot
  // leave a PR alone. Highest-priority skip, marked `ignore` in the table.
  const ignored = hasClawIgnoreLabel(event, payload);
  const IGNORE_REASON = CLAW_IGNORE_SKIP_REASON;

  if (event === "pull_request") {
    // Capture live PR git-state (open/merged/closed/conflicted) for the sidebar
    // BEFORE routine matching, so state is tracked even for PRs no routine
    // subscribes to. Best-effort; never throws on an odd payload.
    recordPrStateFromWebhook(payload);
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
          // loop (e.g. pr-babysit on a `errandd:babysit` PR) rather than waking the
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
    pk: githubExtractPk(event, payload),
    keys: githubExtractKeys(event, payload),
    fields: githubExtractFields(event, payload),
    routines,
  });
  return matched;
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

/** Per-provider receiver status for the Settings UI. */
function githubProviderStatus(origin: string): ProviderStatus {
  const secret = getWebhookSecret();
  return {
    configured: secret.length > 0,
    secret,
    url: `${origin}/api/webhooks/github`,
    secretEnv: "ERRANDD_GITHUB_WEBHOOK_SECRET",
  };
}

/** The GitHub inbound SOURCE plugin. */
export const githubSource: SourcePlugin = {
  id: "github",
  routePath: "/api/webhooks/github",
  aliasPath: "/api/github/webhook",
  webhookSpec: buildGithubSpec,
  // GitHub events are the unprefixed majority; the prefixed providers claim
  // their own namespaces, and `sourceForEvent` falls back here.
  ownsEvent: (event: string) => !event.includes(":"),
  extractFields: githubExtractFields,
  extractKeys: githubExtractKeys,
  extractPk: githubExtractPk,
  configKeys: GITHUB_CONFIG_KEYS,
  parseRule: parseGithubTrigger,
  providerStatus: githubProviderStatus,
};
