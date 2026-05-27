import { FolderList, Window } from "@liiift-studio/mac-os9-ui";
import { useEffect, useMemo, useState } from "react";
import {
  getUsageTimeline,
  type UsageTimelineResponse,
} from "../../api/timeline";
import { getUsage, type SessionUsage } from "../../api/usage";
import { Os9Scroll } from "../components/Os9Scroll";
import { useOs9Hash } from "../useOs9Hash";

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

interface Props {
  maxHeight: number;
}

const INDENT = "    ";
function prefix(depth: number, disclosure: "▷" | "▽" | null): string {
  return `${INDENT.repeat(depth)}${disclosure ?? " "} `;
}

export function HomeSection({ maxHeight }: Props) {
  const [usage, setUsage] = useState<SessionUsage[]>([]);
  const [timeline, setTimeline] = useState<UsageTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const { params, setParam } = useOs9Hash();

  useEffect(() => {
    void (async () => {
      try {
        const [u, t] = await Promise.all([
          getUsage().catch(() => [] as SessionUsage[]),
          getUsageTimeline("24h").catch(() => null),
        ]);
        setUsage(Array.isArray(u) ? u : []);
        setTimeline(t);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Group raw byJob keys like "#every-10m:202605..." into one entry per routine.
  const routineGroups = useMemo(() => {
    if (!timeline) return [] as {
      name: string;
      cost: number;
      runs: { id: string; cost: number }[];
    }[];
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

  // URL hash drives which rows are expanded (`?open=key1,key2`).
  const openSet = useMemo(() => {
    const raw = params.get("open") ?? "";
    return new Set(raw ? raw.split(",") : []);
  }, [params]);
  const toggle = (key: string) => {
    const next = new Set(openSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setParam("open", next.size ? Array.from(next).join(",") : null);
  };

  interface Row {
    id: string;
    name: string;
    cost: string;
    action: (() => void) | null;
  }
  const rows: Row[] = [];

  // Total row.
  rows.push({
    id: "total",
    name: "Total",
    cost: fmtUsd(grandTotal),
    action: null,
  });

  // Chats group.
  const chatsOpen = openSet.has("chats");
  rows.push({
    id: "chats",
    name: `${prefix(0, chatsOpen ? "▽" : "▷")}💬 Chats (${usage.length})`,
    cost: fmtUsd(chatsTotal),
    action: () => toggle("chats"),
  });
  if (chatsOpen) {
    for (const s of usage.slice(0, 50)) {
      rows.push({
        id: `chat:${s.sessionId}`,
        name: `${prefix(1, null)}${s.channel === "web" ? "🌐" : "👾"} ${s.label}`,
        cost: fmtUsd(s.estimatedCostUsd),
        action: null,
      });
    }
  }

  // Per-routine groups.
  for (const r of routineGroups) {
    const key = `r:${r.name}`;
    const open = openSet.has(key);
    rows.push({
      id: key,
      name: `${prefix(0, open ? "▽" : "▷")}⚙ ${r.name} (${r.runs.length})`,
      cost: fmtUsd(r.cost),
      action: () => toggle(key),
    });
    if (open) {
      for (const run of r.runs) {
        rows.push({
          id: `${key}:${run.id}`,
          name: `${prefix(1, null)}📄 ${run.id}`,
          cost: fmtUsd(run.cost),
          action: null,
        });
      }
    }
  }

  return (
    <Window title="Home">
      <Os9Scroll maxHeight={Math.max(200, maxHeight - 36)}>
        <div
          style={{
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {loading ? (
            <p>Loading…</p>
          ) : (
            <FolderList
              title="Usage breakdown — last 24h"
              columns={[
                { key: "name", label: "Name", width: "75%" },
                { key: "cost", label: "Cost", width: "25%" },
              ]}
              items={rows}
              selectedIds={[]}
              onSelectionChange={(ids) => {
                const id = ids[ids.length - 1];
                if (!id) return;
                const row = rows.find((r) => r.id === id);
                row?.action?.();
              }}
              listHeight={Math.max(280, maxHeight - 120)}
            />
          )}
        </div>
      </Os9Scroll>
    </Window>
  );
}
