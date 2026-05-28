/**
 * Editors for the `on.sentry` and `on.datadog` hook-config blocks.
 *
 * Each provider supports two shapes mirrored from src/hooks/schema.ts:
 *   - `true`        → match ANY event from that provider
 *   - a filtered rule with glob/enum lists per field
 *
 * The "match any" toggle flips between `true` and a seeded default rule.
 * Mutations bubble up via `onChange` — the parent persists the resulting
 * HookConfig.sentry / .datadog back into the job frontmatter.
 *
 * Known enum fields (Sentry level, Datadog priority/type) render as
 * toggle-pill rows; free-text fields (project/action, monitor/tags) use
 * the shared <PillList> glob input.
 */

import {
  type DatadogRule,
  defaultDatadogRule,
  defaultSentryRule,
  type SentryRule,
} from "../hookConfig";
import { PillList } from "./HookConfigEditor";

const SENTRY_LEVELS = ["error", "warning", "fatal", "info", "debug"];
const DATADOG_PRIORITIES = ["P1", "P2", "P3", "P4", "P5"];
const DATADOG_TYPES = ["error", "warning", "success", "recovery", "no data"];

// ---------------------------------------------------------------------------

/** Shared "match any vs filtered" header + enum toggle row. */
function MatchAnyToggle({
  matchAny,
  onMatchAny,
  onFilter,
  anyLabel,
}: {
  matchAny: boolean;
  onMatchAny: () => void;
  onFilter: () => void;
  anyLabel: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-base-content/80 cursor-pointer">
      <input
        type="checkbox"
        className="checkbox checkbox-xs"
        checked={matchAny}
        onChange={(e) => (e.target.checked ? onMatchAny() : onFilter())}
      />
      {anyLabel}
    </label>
  );
}

function EnumPills({
  label,
  options,
  selected,
  onChange,
  hint,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  hint?: string;
}) {
  function toggle(opt: string) {
    if (selected.includes(opt)) {
      onChange(selected.filter((s) => s !== opt));
    } else {
      onChange([...selected, opt]);
    }
  }
  return (
    <div>
      <div className="text-xs font-medium mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(opt)}
              className={`btn btn-xs ${on ? "btn-primary" : "btn-ghost border-base-300"}`}
            >
              {opt}
            </button>
          );
        })}
      </div>
      {hint && <div className="text-[11px] text-base-content/50 mt-1">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

export function SentryHookEditor({
  value,
  onChange,
}: {
  value: boolean | SentryRule;
  onChange: (next: boolean | SentryRule) => void;
}) {
  const matchAny = value === true;
  const rule: SentryRule = typeof value === "object" ? value : defaultSentryRule();

  return (
    <div className="space-y-3">
      <MatchAnyToggle
        matchAny={matchAny}
        onMatchAny={() => onChange(true)}
        onFilter={() => onChange(defaultSentryRule())}
        anyLabel="Match any Sentry event"
      />
      {!matchAny && (
        <div className="space-y-3">
          <PillList
            label="Project"
            items={rule.project}
            placeholder="my-app, frontend-*"
            onChange={(next) => onChange({ ...rule, project: next })}
            hint="Project slugs. Glob patterns ok. * matches any project."
          />
          <EnumPills
            label="Level"
            options={SENTRY_LEVELS}
            selected={rule.level}
            onChange={(next) => onChange({ ...rule, level: next })}
            hint="Empty matches any level."
          />
          <PillList
            label="Action"
            items={rule.action}
            placeholder="created, resolved"
            onChange={(next) => onChange({ ...rule, action: next })}
            hint="Issue action (created, resolved, assigned, …). Empty matches any."
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Datadog
// ---------------------------------------------------------------------------

export function DatadogHookEditor({
  value,
  onChange,
}: {
  value: boolean | DatadogRule;
  onChange: (next: boolean | DatadogRule) => void;
}) {
  const matchAny = value === true;
  const rule: DatadogRule = typeof value === "object" ? value : defaultDatadogRule();

  return (
    <div className="space-y-3">
      <MatchAnyToggle
        matchAny={matchAny}
        onMatchAny={() => onChange(true)}
        onFilter={() => onChange(defaultDatadogRule())}
        anyLabel="Match any Datadog alert"
      />
      {!matchAny && (
        <div className="space-y-3">
          <PillList
            label="Monitor"
            items={rule.monitor}
            placeholder="12345, *"
            onChange={(next) => onChange({ ...rule, monitor: next })}
            hint="Monitor IDs. Glob patterns ok. * matches any monitor."
          />
          <EnumPills
            label="Priority"
            options={DATADOG_PRIORITIES}
            selected={rule.priority}
            onChange={(next) => onChange({ ...rule, priority: next })}
            hint="Empty matches any priority."
          />
          <EnumPills
            label="Type"
            options={DATADOG_TYPES}
            selected={rule.type}
            onChange={(next) => onChange({ ...rule, type: next })}
            hint="Alert transition type. Empty matches any."
          />
          <PillList
            label="Tags"
            items={rule.tags}
            placeholder="env:prod, service:api"
            onChange={(next) => onChange({ ...rule, tags: next })}
            hint="Match on alert tags. Empty matches any."
          />
        </div>
      )}
    </div>
  );
}
