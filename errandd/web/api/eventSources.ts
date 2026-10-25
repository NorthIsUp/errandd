import type { CveSubscriptionInfo } from "../../shared/cveSubscriptions";
import type { CveConnection, EventSourceInfo } from "../../shared/eventSources";
import { apiJSON } from "./client";
export type { CveConnection, EventSourceInfo };
export const getEventSources = () =>
  apiJSON<{ sources: EventSourceInfo[] }>("/api/settings/event-sources");
export const saveCveSource = (connection: CveConnection) =>
  apiJSON<{ ok: true; connection: CveConnection }>("/api/settings/event-sources/cve", {
    method: "PUT",
    body: JSON.stringify(connection),
  });
export const testCveSource = (connection: CveConnection) =>
  apiJSON<{ ok: true; format: string; records: number | null }>(
    "/api/settings/event-sources/cve/test",
    { method: "POST", body: JSON.stringify(connection) },
  );

export const getCveSubscriptions = () =>
  apiJSON<{ subscriptions: CveSubscriptionInfo[] }>("/api/cve/subscriptions");
