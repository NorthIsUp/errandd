import { useEffect, useMemo, useState } from "react";
import {
  getUsageTimeline,
  type TimeRange,
  type UsageTimelineResponse,
} from "../api/timeline";
import { getUsage, type SessionUsage } from "../api/usage";

export interface RoutineRun {
  id: string;
  cost: number;
}

export interface RoutineGroup {
  name: string;
  cost: number;
  runs: RoutineRun[];
}

export interface UseHomeUsageResult {
  loading: boolean;
  usage: SessionUsage[];
  timeline: UsageTimelineResponse | null;
  routineGroups: RoutineGroup[];
  chatsTotal: number;
  routinesTotal: number;
  grandTotal: number;
}

/**
 * Headless data hook shared by HomeSection across UI bundles. Loads usage
 * (per-session) and a usage timeline (bucketed by time), then groups raw
 * `byJob` keys like `"#every-10m:202605…"` into one entry per routine. The
 * bundle-specific HomeSection renders the resulting numbers with its own
 * chrome.
 */
export function useHomeUsage(range: TimeRange = "24h"): UseHomeUsageResult {
  const [usage, setUsage] = useState<SessionUsage[]>([]);
  const [timeline, setTimeline] = useState<UsageTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [u, t] = await Promise.all([
          getUsage().catch(() => [] as SessionUsage[]),
          getUsageTimeline(range).catch(() => null),
        ]);
        if (cancelled) return;
        setUsage(Array.isArray(u) ? u : []);
        setTimeline(t);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const routineGroups = useMemo<RoutineGroup[]>(() => {
    if (!timeline) return [];
    const groups = new Map<string, { cost: number; runs: Map<string, number> }>();
    for (const b of timeline.buckets) {
      for (const [job, cost] of Object.entries(b.byJob)) {
        const [routine, runId] = job.split(":");
        const key = routine ?? job;
        const g = groups.get(key) ?? { cost: 0, runs: new Map<string, number>() };
        g.cost += cost;
        if (runId) g.runs.set(runId, (g.runs.get(runId) ?? 0) + cost);
        groups.set(key, g);
      }
    }
    return Array.from(groups.entries())
      .map(([name, g]) => ({
        name,
        cost: g.cost,
        runs: Array.from(g.runs.entries())
          .map(([id, cost]) => ({ id, cost }))
          .sort((a, b) => b.cost - a.cost),
      }))
      .sort((a, b) => b.cost - a.cost);
  }, [timeline]);

  const chatsTotal = useMemo(
    () => usage.reduce((s, u) => s + u.estimatedCostUsd, 0),
    [usage],
  );
  const routinesTotal = useMemo(
    () => routineGroups.reduce((s, r) => s + r.cost, 0),
    [routineGroups],
  );
  const grandTotal = chatsTotal + routinesTotal;

  return {
    loading,
    usage,
    timeline,
    routineGroups,
    chatsTotal,
    routinesTotal,
    grandTotal,
  };
}
