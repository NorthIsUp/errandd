import type { DeliveryBase } from "../../shared/deliveryTypes";
import { apiJSON } from "./client";

// Delivery types are shared with the daemon — see shared/deliveryTypes.ts.
export type {
  DeliveryField,
  DeliveryKeys,
  DeliveryRoutine,
  DeliverySource,
} from "../../shared/deliveryTypes";

/** Wire/web delivery — the shared base (the daemon adds an in-memory payload). */
export type Delivery = DeliveryBase;

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

// Durable hook queue — mirrors src/hookQueue.ts QueuedMessage (minus payload).
export type QueueStatus = "pending" | "running" | "done" | "failed";

export interface QueueMessage {
  id: string;
  /** `<job>:hook:pr-<num>-<slug>` — the resumed Claude session. */
  threadId: string;
  jobName: string;
  event: string;
  scope: string;
  enqueuedAt: number;
  status: QueueStatus;
  attempts: number;
  /** Epoch ms before which a deferred message reruns (rate-limit / backoff). */
  notBefore: number;
  prRepo: string | null;
  prNumber: number | null;
  error: string | null;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export function getReceiverStatus(): Promise<ReceiverStatus> {
  return apiJSON<ReceiverStatus>("/api/hooks/receiver");
}

export function listQueue(): Promise<{ messages: QueueMessage[] }> {
  return apiJSON<{ messages: QueueMessage[] }>("/api/hooks/queue");
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
