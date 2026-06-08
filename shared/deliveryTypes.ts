/**
 * Shared webhook-delivery types — the single source of truth imported by BOTH
 * the bun daemon (`src/hooks/deliveries.ts`) and the esbuild web bundle
 * (`web/api/hooks.ts`). Pure types only: no node/bun imports, so it bundles
 * into the browser and loads in the daemon unchanged.
 *
 * The daemon's `Delivery` extends `DeliveryBase` with an in-memory `payload`;
 * the wire/web shape is `DeliveryBase` as-is.
 */

export type DeliverySource = "github" | "sentry" | "datadog" | "linear";

export interface DeliveryField {
  label: string;
  value: string;
}

export interface DeliveryKeys {
  key1Label: string;
  key1: string;
  key2Label: string;
  key2: string;
}

export interface DeliveryRoutine {
  job: string;
  outcome: "trigger" | "skip";
  /** Why it skipped (config filter, self-skip, claw:ignore, …). Unset for triggers. */
  reason?: string;
}

export type DeliveryStatus = "ok" | "duplicate" | "bad-signature" | "missing-secret" | "error";

/** Fields common to the daemon's in-memory delivery and the wire/web shape. */
export interface DeliveryBase {
  /** Provider delivery id — dedup key + ring entry id. */
  id: string;
  /** Provider event name (e.g. "pull_request", "sentry:issue", "datadog:alert"). */
  event: string;
  receivedAt: number;
  /** Human one-liner derived from the payload. */
  summary: string;
  status: DeliveryStatus;
  /** Job names that fired for this delivery. */
  matched: string[];
  /** First ~2KB of the raw body for cheap inspection. */
  payloadSnippet: string;
  /** Provider, normalized from `event` on record. */
  source?: DeliverySource;
  /** Short headline id — GitHub PR#/branch, Sentry issue id, Datadog monitor. */
  pk?: string;
  /** The two labeled "key" columns (provider-specific). */
  keys?: DeliveryKeys;
  /** "Most important" extracted fields passed to routines. */
  fields?: DeliveryField[];
  /** Per-routine trigger/skip outcomes. */
  routines?: DeliveryRoutine[];
}
