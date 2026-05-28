import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirror src/hooks/deliveries.ts Delivery
// ---------------------------------------------------------------------------

export interface Delivery {
  id: string;
  event: string;
  receivedAt: number;
  summary: string;
  status: "ok" | "duplicate" | "bad-signature" | "missing-secret" | "error";
  matched: string[];
  payloadSnippet: string;
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
