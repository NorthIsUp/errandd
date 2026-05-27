import cronstrue from "cronstrue";
import { useEffect, useState } from "react";
import type { HookConfig } from "../hookConfig";
import { describeWait, nextRunAt } from "../schedule";

/**
 * Compact one-line summary of how a job fires.
 *
 * Three states:
 *  - cron only      → human label · next run · wait countdown
 *  - hooks only     → "On GitHub triggers" + one short line per rule
 *  - cron + hooks   → both blocks stacked
 *
 * The countdown ticks every second so users see the next-run window
 * shrink in real time without having to refresh.
 */
export function ScheduleReadout({
  cron,
  hookConfig,
}: {
  cron: string;
  hookConfig?: HookConfig | null;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const trimmed = cron.trim();
  const next = trimmed ? nextRunAt(trimmed, now) : null;
  const hookLines = hookConfig ? describeHooks(hookConfig) : [];
  const hasCron = !!trimmed;
  const hasHooks = hookLines.length > 0;

  // No cron and no hooks → keep the old "No schedule set" copy.
  if (!hasCron && !hasHooks) {
    return (
      <div className="rounded-box border border-base-300 bg-base-200 px-3 py-2 text-sm">
        <span className="font-medium">No schedule set</span>
      </div>
    );
  }

  return (
    <div className="rounded-box border border-base-300 bg-base-200 px-3 py-2 text-sm space-y-2">
      {hasCron && (
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium truncate">{humanizeCron(trimmed)}</span>
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
      )}
      {hasHooks && (
        <div>
          <div className="font-medium">On GitHub triggers</div>
          <ul className="text-xs text-base-content/70 mt-0.5 space-y-0.5">
            {hookLines.map((line) => (
              <li key={line}>· {line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function humanizeCron(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true });
  } catch {
    return "Invalid cron expression";
  }
}

/** Render a HookConfig as one short line per active rule. */
function describeHooks(cfg: HookConfig): string[] {
  const lines: string[] = [];
  if (cfg.comments) {
    lines.push("any review / comment / review-comment delivery");
  }
  for (const rule of cfg.pr ?? []) {
    const repo = stringOrList(rule.repo) || "*/*";
    const action = rule.action?.length ? rule.action.join(", ") : "default actions";
    const branch = rule.branch?.length ? `branch ${rule.branch.join(", ")}` : "any branch";
    const user = rule.user?.length ? `user ${rule.user.join(", ")}` : "any user";
    const draftBit =
      rule.draft === "any" ? "incl. drafts" : rule.draft === true ? "drafts only" : "non-draft";
    lines.push(`pull_request · ${repo} · ${action} · ${branch} · ${user} · ${draftBit}`);
  }
  return lines;
}

function stringOrList(v: string | string[] | undefined): string {
  if (!v) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}
