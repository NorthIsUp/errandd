import type { SessionUsage } from "../../api/usage";

/**
 * Minimal stacked-token bar chart per session, rendered with pure CSS bars.
 * No external chart lib — daisyUI tokens for colors, flex for layout.
 */
export function UsageChart({ sessions }: { sessions: SessionUsage[] }) {
  if (sessions.length === 0) {
    return <div className="text-sm text-base-content/60 italic">No usage recorded yet.</div>;
  }

  const max = Math.max(
    1,
    ...sessions.map((s) => s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens),
  );

  return (
    <div className="space-y-2">
      {sessions.slice(0, 12).map((s) => {
        const total = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
        const pct = (n: number) => (n / max) * 100;
        return (
          <div key={s.sessionId} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate font-medium" title={s.label}>
                {s.label || s.sessionId.slice(0, 8)}
              </span>
              <span className="tabular-nums text-base-content/60">
                {total.toLocaleString()} tok · {`$${s.estimatedCostUsd.toFixed(3)}`}
              </span>
            </div>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-base-200">
              <div
                className="bg-primary"
                style={{ width: `${pct(s.inputTokens)}%` }}
                title={`input ${s.inputTokens.toLocaleString()}`}
              />
              <div
                className="bg-secondary"
                style={{ width: `${pct(s.outputTokens)}%` }}
                title={`output ${s.outputTokens.toLocaleString()}`}
              />
              <div
                className="bg-accent/70"
                style={{ width: `${pct(s.cacheReadTokens)}%` }}
                title={`cache read ${s.cacheReadTokens.toLocaleString()}`}
              />
              <div
                className="bg-info/60"
                style={{ width: `${pct(s.cacheWriteTokens)}%` }}
                title={`cache write ${s.cacheWriteTokens.toLocaleString()}`}
              />
            </div>
          </div>
        );
      })}
      <Legend />
    </div>
  );
}

function Legend() {
  const items: { label: string; cls: string }[] = [
    { label: "input", cls: "bg-primary" },
    { label: "output", cls: "bg-secondary" },
    { label: "cache read", cls: "bg-accent/70" },
    { label: "cache write", cls: "bg-info/60" },
  ];
  return (
    <div className="flex flex-wrap gap-3 pt-1 text-xs text-base-content/70">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={`w-3 h-3 rounded-sm ${i.cls}`} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}
