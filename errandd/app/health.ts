/**
 * Liveness + readiness state for the `/healthz` and `/readyz` probes.
 *
 * - **Liveness** (`/healthz`) is implicit: if the HTTP server answers, the
 *   process is alive. The endpoint always returns 200.
 * - **Readiness** (`/readyz`) gates on startup completion AND, when the web UI
 *   is enabled, on the web bundle actually being built. A daemon whose UI failed
 *   to build serves 5xx for every /ui/ route, which is not a healthy instance —
 *   it used to go Ready anyway and 404 the dashboard for the life of the deploy.
 *   Readiness flips back to `false` the moment a shutdown signal arrives.
 *
 * Wired so a deploy orchestrator (Fly/k8s/compose/etc.) can poll `/readyz` and
 * only cut traffic to the NEW instance once it's ready — and stop sending to the
 * OLD one as it drains — eliminating the during-deploy outage window.
 */

let ready = false;

/**
 * Whether this daemon serves a web UI at all. A `--no-web` daemon has no bundle
 * to build, so it must not be held un-ready waiting for one.
 */
let webBundleRequired = false;
let webBundleReady = false;

/** Mark the daemon ready (true after startup) / not-ready (false on shutdown). */
export function setReady(value: boolean): void {
  ready = value;
}

/** Declare that this daemon serves the web UI, so readiness gates on its bundle. */
export function requireWebBundle(): void {
  webBundleRequired = true;
}

/** Record the outcome of the boot-time web build. */
export function setWebBundleReady(value: boolean): void {
  webBundleReady = value;
}

/** True when the web bundle is servable (or isn't required by this daemon). */
export function isWebBundleReady(): boolean {
  return !webBundleRequired || webBundleReady;
}

/** True once startup finished, the UI can be served, and no shutdown has begun. */
export function isReady(): boolean {
  return ready && isWebBundleReady();
}

/** Why `/readyz` is failing, for the probe body (empty when ready). */
export function notReadyReason(): string {
  if (!ready) {
    return "starting up or shutting down";
  }
  if (!isWebBundleReady()) {
    return "web bundle not built";
  }
  return "";
}

/** Test-only: restore module state between cases. */
export function __resetHealthForTest(): void {
  ready = false;
  webBundleRequired = false;
  webBundleReady = false;
}
