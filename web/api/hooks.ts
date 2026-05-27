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

export interface ReceiverStatus {
  configured: boolean;
  /** Raw secret value when set; empty string when unset. */
  secret: string;
  url: string;
  lastEventAt: number | null;
  lastEvent: string | null;
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
