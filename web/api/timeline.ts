import { apiJSON } from "./client";

export type TimeRange = "1h" | "24h" | "7d" | "30d";

export interface TimelineBucket {
  ts: string; // ISO 8601
  totalCostUsd: number;
  totalTokens: number;
  byJob: Record<string, number>;
}

export interface UsageTimelineResponse {
  buckets: TimelineBucket[];
}

export function getUsageTimeline(range: TimeRange): Promise<UsageTimelineResponse> {
  return apiJSON<UsageTimelineResponse>(`/api/usage-timeline?range=${encodeURIComponent(range)}`);
}

export interface ScheduleDensityPoint {
  hour: number;
  count: number;
}

export interface ScheduleDensityResponse {
  data: ScheduleDensityPoint[];
}

export function getScheduleDensity(): Promise<ScheduleDensityResponse> {
  return apiJSON<ScheduleDensityResponse>("/api/schedule-density");
}
