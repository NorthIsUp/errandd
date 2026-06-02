import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirror src/hooks/deliveries.ts Delivery
// ---------------------------------------------------------------------------

export type DeliverySource = "github" | "sentry" | "datadog";

export interface DeliveryField {
  label: string;
  value: string;
}

export interface DeliveryRoutine {
  job: string;
  outcome: "trigger" | "skip";
  reason?: string;
}

export interface DeliveryKeys {
  key1Label: string;
  key1: string;
  key2Label: string;
  key2: string;
}

export interface Delivery {
  id: string;
  event: string;
  receivedAt: number;
  summary: string;
  status: "ok" | "duplicate" | "bad-signature" | "missing-secret" | "error";
  matched: string[];
  payloadSnippet: string;
  /** Provider — present on daemons ≥ the deliveries-tab build. */
  source?: DeliverySource;
  /** Short headline id: GitHub PR#/branch, Sentry issue id, Datadog monitor. */
  pk?: string;
  /** The two labeled "key" columns (provider-specific). */
  keys?: DeliveryKeys;
  /** "Most important" extracted fields passed to routines. */
  fields?: DeliveryField[];
  /** Per-routine trigger/skip outcomes (with skip reasons). */
  routines?: DeliveryRoutine[];
}

export interface StoredDeliveryPayload {
  event: string;
  payload: unknown;
}

/** Per-provider receiver status, returned under `providers` in the new
 *  multi-provider receiver endpoint. */
export interface ProviderReceiver {
  configured: boolean;
  /** Raw secret value when set; empty string when unset. */
  secret: string;
  url: string;
  /** Env var the secret is read from, e.g. CLAWDCODE_SENTRY_CLIENT_SECRET. */
  secretEnv: string;
  /** Datadog only: the webhook URL with `?token=` baked in. */
  tokenUrl?: string;
  /** Datadog only: recommended payload template (object) to paste into
   *  the Datadog webhook Payload field. */
  recommendedPayload?: unknown;
}

export interface ReceiverStatus {
  configured: boolean;
  /** Raw secret value when set; empty string when unset. */
  secret: string;
  url: string;
  lastEventAt: number | null;
  lastEvent: string | null;
  /** Per-provider receiver status for the multi-provider UI. May be
   *  absent on older daemons (back-compat top-level fields still work). */
  providers?: {
    github: ProviderReceiver;
    sentry: ProviderReceiver;
    datadog: ProviderReceiver;
  };
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export function getReceiverStatus(): Promise<ReceiverStatus> {
  return apiJSON<ReceiverStatus>("/api/hooks/receiver");
}

export function listDeliveries(): Promise<{ deliveries: Delivery[] }> {
  return apiJSON<{ deliveries: Delivery[] }>("/api/hooks/deliveries");
}

/** Full parsed payload for a single delivery, fetched on demand. */
export function getDeliveryPayload(id: string): Promise<StoredDeliveryPayload> {
  return apiJSON<StoredDeliveryPayload>(`/api/hooks/deliveries/${encodeURIComponent(id)}/payload`);
}

export interface PrTrigger {
  job: string;
  agent: string | null;
  repo: string | string[];
  user: string[];
  action: string[];
  branch: string[];
  labels: string[];
  draft: boolean | "any";
}

export function listTriggers(): Promise<{ triggers: PrTrigger[] }> {
  return apiJSON<{ triggers: PrTrigger[] }>("/api/hooks/triggers");
}
