import type { Job } from "../jobs";
import type { SourcePlugin } from "./sources";
import { handleSignedWebhook } from "./webhookEnvelope";

/**
 * Generic inbound webhook dispatcher.
 *
 * `receiver.ts` no longer knows any provider by name. Every source (github /
 * sentry / datadog / linear, plus any plugin-registered source) is a
 * `SourcePlugin` in the registry (`./sources`); `dispatchInbound` looks the
 * source up, builds its per-request `WebhookSpec`, and drives the shared
 * `handleSignedWebhook` lifecycle. There is ZERO per-provider branching here.
 *
 * `WebhookDeps` / `ReceiverResult` live here (the shared contract every source
 * and the server speak). The GitHub-specific `handleWebhook` / `dispatchHook` /
 * `getWebhookSecret` are re-exported from `./github` for back-compat with the
 * callers (server, sessions route, tests) that still import them by name.
 */

export interface ReceiverResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; error?: string; matched?: string[] };
}

export interface WebhookDeps {
  /** Called fresh per delivery so newly-added hook config is picked up
   *  without a daemon restart. */
  getJobs?: () => Job[] | Promise<Job[]>;
  /** A complete lockfile rescan proved this finding no longer affects the target. */
  onCveResolved?: (job: string, repository: string, aliases: string[]) => void;
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

/**
 * Drive one inbound delivery through the shared signed-webhook lifecycle for
 * the given source. Generic over every provider: the source supplies its
 * `WebhookSpec` (auth, identity derivation, match callback, …) and the envelope
 * owns the invariant skeleton (content-type guard → auth → parse → record →
 * dedup → match → evaluate). No per-source logic lives here.
 */
export function dispatchInbound(
  source: SourcePlugin,
  req: Request,
  deps: WebhookDeps = {},
): Promise<ReceiverResult> {
  return handleSignedWebhook(req, deps, source.webhookSpec());
}

// Back-compat re-exports: the GitHub receiver moved to `./github` when it was
// folded into the envelope path, but `handleWebhook` / `dispatchHook` /
// `getWebhookSecret` keep their `../hooks/receiver` import surface.
export { dispatchHook, getWebhookSecret, handleWebhook } from "./github";
