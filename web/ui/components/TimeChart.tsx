import type { SessionUsage } from "../../api/usage";

export type Bucket = "day" | "week" | "month";

interface BinAgg {
  key: string;
  label: string;
  start: number;
  input: number;
  output: number;
  cacheR: number;
  cacheW: number;
  cost: number;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = (day + 6) % 7; // Monday-anchored
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - diff);
  return s;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function shortLabel(start: Date, bucket: Bucket): string {
  if (bucket === "day") {
    return start.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  }
  if (bucket === "week") {
    return start.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  }
  return start.toLocaleDateString(undefined, { month: "short" });
}

function bucketsFor(bucket: Bucket): { start: Date; key: string; label: string }[] {
  const out: { start: Date; key: string; label: string }[] = [];
  const now = new Date();
  if (bucket === "day") {
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const s = startOfDay(d);
      out.push({ start: s, key: s.toISOString().slice(0, 10), label: shortLabel(s, bucket) });
    }
  } else if (bucket === "week") {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      const s = startOfWeek(d);
      out.push({ start: s, key: s.toISOString().slice(0, 10), label: shortLabel(s, bucket) });
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - i);
      const s = startOfMonth(d);
      out.push({
        start: s,
        key: `${s.getFullYear()}-${s.getMonth()}`,
        label: shortLabel(s, bucket),
      });
    }
  }
  return out;
}

function bucketKey(ts: number, bucket: Bucket): string {
  const d = new Date(ts);
  if (bucket === "day") {
    return startOfDay(d).toISOString().slice(0, 10);
  }
  if (bucket === "week") {
    return startOfWeek(d).toISOString().slice(0, 10);
  }
  const s = startOfMonth(d);
  return `${s.getFullYear()}-${s.getMonth()}`;
}

export function TimeChart({ sessions, bucket }: { sessions: SessionUsage[]; bucket: Bucket }) {
  const bins = bucketsFor(bucket);
  const agg = new Map<string, BinAgg>();
  for (const b of bins) {
    agg.set(b.key, {
      key: b.key,
      label: b.label,
      start: b.start.getTime(),
      input: 0,
      output: 0,
      cacheR: 0,
      cacheW: 0,
      cost: 0,
    });
  }
  for (const s of sessions) {
    const ts = new Date(s.lastUsedAt).getTime();
    if (!Number.isFinite(ts)) {
      continue;
    }
    const key = bucketKey(ts, bucket);
    const row = agg.get(key);
    if (!row) {
      continue;
    }
    row.input += s.inputTokens;
    row.output += s.outputTokens;
    row.cacheR += s.cacheReadTokens;
    row.cacheW += s.cacheWriteTokens;
    row.cost += s.estimatedCostUsd;
  }
  const rows = bins.map(
    (b) =>
      agg.get(b.key) ?? {
        key: b.key,
        label: b.label,
        start: b.start.getTime(),
        input: 0,
        output: 0,
        cacheR: 0,
        cacheW: 0,
        cost: 0,
      },
  );
  const max = Math.max(1, ...rows.map((r) => r.input + r.output + r.cacheR + r.cacheW));
  const totalTok = rows.reduce((a, r) => a + r.input + r.output + r.cacheR + r.cacheW, 0);
  const totalCost = rows.reduce((a, r) => a + r.cost, 0);

  return (
    <div>
      <div className="flex items-end gap-[2px] h-32 w-full">
        {rows.map((r) => {
          const total = r.input + r.output + r.cacheR + r.cacheW;
          const h = (total / max) * 100;
          return (
            <div
              key={r.key}
              className="flex-1 min-w-0 flex flex-col justify-end h-full"
              title={`${r.label} · ${total.toLocaleString()} tok · $${r.cost.toFixed(3)}`}
            >
              <div
                className="w-full flex flex-col-reverse overflow-hidden rounded-t"
                style={{ height: `${h}%` }}
              >
                <div className="bg-primary" style={{ flex: r.input }} />
                <div className="bg-secondary" style={{ flex: r.output }} />
                <div className="bg-accent/70" style={{ flex: r.cacheR }} />
                <div className="bg-info/60" style={{ flex: r.cacheW }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-base-content/60 mt-1 tabular-nums">
        <span>{rows[0]?.label}</span>
        <span>{rows[Math.floor(rows.length / 2)]?.label}</span>
        <span>{rows[rows.length - 1]?.label}</span>
      </div>
      <div className="flex justify-between text-xs text-base-content/70 mt-2 tabular-nums">
        <span>{totalTok.toLocaleString()} tokens</span>
        <span>${totalCost.toFixed(3)}</span>
      </div>
    </div>
  );
}
