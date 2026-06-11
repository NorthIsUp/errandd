/**
 * Liveness + readiness state for the `/healthz` and `/readyz` probes.
 *
 * - **Liveness** (`/healthz`) is implicit: if the HTTP server answers, the
 *   process is alive. The endpoint always returns 200.
 * - **Readiness** (`/readyz`) gates on this flag. It starts `false` and flips
 *   `true` only once daemon startup has fully initialized (server listening,
 *   jobs loaded, queues open, maintenance kicked off). It flips back to `false`
 *   the moment a shutdown signal arrives.
 *
 * Wired so a deploy orchestrator (Fly/k8s/compose/etc.) can poll `/readyz` and
 * only cut traffic to the NEW instance once it's ready — and stop sending to the
 * OLD one as it drains — eliminating the during-deploy outage window.
 */

let ready = false;

/** Mark the daemon ready (true after startup) / not-ready (false on shutdown). */
export function setReady(value: boolean): void {
  ready = value;
}

/** True once startup finished and a shutdown hasn't begun. */
export function isReady(): boolean {
  return ready;
}
