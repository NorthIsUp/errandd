import {
  AreaChart,
  BarChart,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  LineChart,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@pikoloo/darwin-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TimeRange } from "../../api/timeline";
import { getScheduleDensity, getUsageTimeline } from "../../api/timeline";
import type { SessionUsage } from "../../api/usage";
import { useFragmentState } from "../../hooks/useHash";
import styles from "./DashboardCharts.module.css";

// ---------------------------------------------------------------------------
// Time range selector
// ---------------------------------------------------------------------------

const RANGES: TimeRange[] = ["1h", "24h", "7d", "30d"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtLabel(ts: string, range: TimeRange): string {
  const d = new Date(ts);
  if (range === "1h") {
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  if (range === "24h") {
    return `${d.getHours().toString().padStart(2, "0")}h`;
  }
  if (range === "7d") {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  // 30d
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  allUsage: SessionUsage[];
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DashboardCharts({ allUsage }: Props) {
  const [rangeRaw, setRange] = useFragmentState("range", "24h");
  const range: TimeRange = (RANGES.includes(rangeRaw as TimeRange) ? rangeRaw : "24h") as TimeRange;

  // Usage timeline state
  const [timelineBuckets, setTimelineBuckets] = useState<
    Array<{ ts: string; totalCostUsd: number; totalTokens: number; byJob: Record<string, number> }>
  >([]);
  const [scheduleDensity, setScheduleDensity] = useState<Array<{ hour: number; count: number }>>([]);
  const [loadingTimeline, setLoadingTimeline] = useState(true);

  const loadTimeline = useCallback(async (r: TimeRange) => {
    setLoadingTimeline(true);
    try {
      const [tl, sd] = await Promise.all([
        getUsageTimeline(r),
        getScheduleDensity(),
      ]);
      setTimelineBuckets(tl.buckets);
      setScheduleDensity(sd.data);
    } catch {
      // keep stale data
    } finally {
      setLoadingTimeline(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadTimeline is stable
  useEffect(() => {
    void loadTimeline(range);
  }, [range, loadTimeline]);

  // ── Activity timeline data ────────────────────────────────────────────────
  // Use allUsage (already loaded) bucketed by channel for the selected window.
  const activityData = useMemo<Record<string, string | number>[]>(() => {
    if (timelineBuckets.length === 0) return [];
    const now = Date.now();
    const rangeMs: Record<TimeRange, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
    const windowMs = rangeMs[range];
    const bucketCount = timelineBuckets.length;
    const bucketMs = windowMs / bucketCount;
    const cutoff = now - windowMs;

    type Row = Record<string, string | number>;
    const rows: Row[] = timelineBuckets.map((b) => ({ ts: fmtLabel(b.ts, range), job: 0, web: 0, discord: 0, other: 0 }));

    for (const s of allUsage) {
      const t = s.lastUsedAt ? new Date(s.lastUsedAt).getTime() : 0;
      if (t < cutoff || t > now) continue;
      const idx = Math.min(bucketCount - 1, Math.floor((t - cutoff) / bucketMs));
      const row = rows[idx];
      if (!row) continue;
      const ch = s.channel === "discord" ? "discord" : s.channel === "web" ? "web" : "other";
      (row[ch] as number) += 1;
    }
    return rows;
  }, [timelineBuckets, allUsage, range]);

  // ── Token cost timeline ───────────────────────────────────────────────────
  const costData = useMemo<Record<string, string | number>[]>(() => {
    return timelineBuckets.map((b) => ({
      ts: fmtLabel(b.ts, range),
      cost: Number(b.totalCostUsd.toFixed(4)),
    }));
  }, [timelineBuckets, range]);

  // ── Top jobs by token count ───────────────────────────────────────────────
  const topJobsData = useMemo<Record<string, string | number>[]>(() => {
    const now = Date.now();
    const rangeMs: Record<TimeRange, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
    const windowMs = rangeMs[range];
    const cutoff = now - windowMs;
    const totals: Record<string, number> = {};
    for (const s of allUsage) {
      const t = s.lastUsedAt ? new Date(s.lastUsedAt).getTime() : 0;
      if (t < cutoff) continue;
      const key = s.label || "unnamed";
      totals[key] = (totals[key] ?? 0) + s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
    }
    return Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([job, tokens]) => ({ job, tokens }));
  }, [allUsage, range]);

  // ── Schedule density ─────────────────────────────────────────────────────
  const densityData = useMemo<Record<string, string | number>[]>(() => {
    return scheduleDensity.map((d) => ({
      hour: `${d.hour.toString().padStart(2, "0")}h`,
      jobs: d.count,
    }));
  }, [scheduleDensity]);

  return (
    <div className={styles.dashWrap}>
      {/* Time range selector */}
      <div className={styles.rangeRow}>
        <Tabs value={range} onValueChange={(v) => setRange(v)} glass>
          <TabsList>
            {RANGES.map((r) => (
              <TabsTrigger key={r} value={r}>
                {r}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* 2×2 chart grid */}
      <div className={styles.chartGrid}>
        {/* Activity timeline */}
        <Card glass>
          <CardHeader>
            <CardTitle>Activity Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <AreaChart
              data={activityData}
              xKey="ts"
              areas={[
                { dataKey: "web", name: "Web", fill: "var(--color-primary)" },
                { dataKey: "discord", name: "Discord", fill: "var(--color-info)" },
                { dataKey: "other", name: "Other", fill: "var(--color-muted)" },
              ]}
              height={180}
              showGrid
              showLegend
              stacked
            />
          </CardContent>
        </Card>

        {/* Schedule density */}
        <Card glass>
          <CardHeader>
            <CardTitle>Schedule Density</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart
              data={densityData}
              xKey="hour"
              bars={[{ dataKey: "jobs", name: "Jobs", fill: "var(--color-success)" }]}
              height={180}
              showGrid
            />
          </CardContent>
        </Card>

        {/* Token cost timeline */}
        <Card glass>
          <CardHeader>
            <CardTitle>Token Cost (USD)</CardTitle>
          </CardHeader>
          <CardContent>
            <LineChart
              data={costData}
              xKey="ts"
              lines={[{ dataKey: "cost", name: "Cost USD", stroke: "var(--color-warning)" }]}
              height={180}
              showGrid
            />
          </CardContent>
        </Card>

        {/* Top jobs by token count */}
        <Card glass>
          <CardHeader>
            <CardTitle>Top Jobs by Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart
              data={topJobsData}
              xKey="job"
              bars={[{ dataKey: "tokens", name: "Tokens", fill: "var(--color-accent)" }]}
              height={180}
              showGrid
            />
          </CardContent>
        </Card>
      </div>

      {loadingTimeline && (
        <div className={styles.loadingOverlay} aria-live="polite" aria-label="Loading chart data" />
      )}
    </div>
  );
}
