import cronstrue from "cronstrue";
import { useEffect, useState } from "react";
import { describeWait, nextRunAt } from "../schedule";

/**
 * Compact one-line summary of a cron string: human label · next run · wait.
 * The countdown ticks every second so users see the next-run window
 * shrink in real time without having to refresh.
 */
export function ScheduleReadout({ cron }: { cron: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const trimmed = cron.trim();
  const human = humanize(trimmed);
  const next = trimmed ? nextRunAt(trimmed, now) : null;
  return (
    <div className="rounded-box border border-base-300 bg-base-200 px-3 py-2 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium truncate">{human}</span>
        <span className="text-xs text-base-content/60 tabular-nums shrink-0">
          {describeWait(next, now) ?? "—"}
        </span>
      </div>
      {next && (
        <div className="text-xs text-base-content/60 tabular-nums mt-0.5">
          next run · {next.toLocaleString()}
        </div>
      )}
    </div>
  );
}

function humanize(cron: string): string {
  if (!cron) {
    return "No schedule set";
  }
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true });
  } catch {
    return "Invalid cron expression";
  }
}
