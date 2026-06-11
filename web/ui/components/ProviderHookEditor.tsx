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

const DATADOG_PRIORITIES = ["P1", "P2", "P3", "P4", "P5"];
const DATADOG_TYPES = ["error", "warning", "success", "recovery", "no data"];

// ---------------------------------------------------------------------------

/** Shared "match any vs filtered" slider. ON ⇒ match every event from this
 *  provider; OFF ⇒ reveal the per-field filters. */
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
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="flex flex-col">
        <span className="text-sm font-medium text-base-content">{anyLabel}</span>
        <span className="text-[11px] text-base-content/50">
          {matchAny ? "Matching everything — filters off." : "Filtered — set the fields below."}
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={anyLabel}
        className="toggle toggle-sm toggle-primary"
        checked={matchAny}
        onChange={(e) => (e.target.checked ? onMatchAny() : onFilter())}
      />
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

/**
 * Sentry severity grouped into plain language instead of raw levels. Sentry's
 * scale is debug < info < warning < error < fatal; "fatal" is the most severe
 * (a crash that took the process/app down), so it groups with "error" as the
 * stuff you actually want to wake up for.
 */
const SENTRY_SEVERITY: { label: string; levels: string[] }[] = [
  { label: "Bad things", levels: ["error", "fatal"] },
  { label: "Warnings", levels: ["warning"] },
  { label: "Infos", levels: ["info", "debug"] },
];

/** Severity picker over the friendly groups. A group is on when all its raw
 *  levels are selected; toggling adds/removes the whole group. */
function SeverityPills({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(levels: string[]) {
    const on = levels.every((l) => selected.includes(l));
    onChange(
      on
        ? selected.filter((l) => !levels.includes(l))
        : [...new Set([...selected, ...levels])],
    );
  }
  return (
    <div>
      <div className="text-xs font-medium mb-1">Severity</div>
      <div className="flex flex-wrap gap-1.5">
        {SENTRY_SEVERITY.map(({ label, levels }) => {
          const on = levels.every((l) => selected.includes(l));
          return (
            <button
              key={label}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(levels)}
              className={`btn btn-xs ${on ? "btn-primary" : "btn-ghost border-base-300"}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="text-[11px] text-base-content/50 mt-1">
        None selected = any severity. “Bad things” = errors &amp; fatal crashes.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

/** Environment globs that count as "production". The common case is prod-only,
 *  so the editor exposes this as a single toggle rather than a glob list. */
const PROD_ENV_PATTERNS = ["prod-*", "*-prod", "prod", "production"];
/** Resource types that are actual errors/problems (vs comment/seer/build noise). */
const ERROR_RESOURCES = ["issue", "error"];

/** An explicit "match every Sentry event" rule (every resource/project/env,
 *  any severity/action). Used instead of the bare `true`, which the backend
 *  deliberately downgrades to PROD-ONLY matching — so the toggle means what it
 *  says. */
function sentryMatchAll(): SentryRule {
  return { resource: [], project: ["*"], environment: [], level: [], action: [], host: [] };
}

/** "Errors only" toggle: ON ⇒ issue/error resources; OFF ⇒ all webhook types
 *  (comments, seer, preprod artifacts, …). */
function ErrorsOnlyToggle({
  resource,
  onChange,
}: {
  resource: string[];
  onChange: (next: string[]) => void;
}) {
  const errorsOnly = resource.length > 0;
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="flex flex-col">
        <span className="text-sm font-medium text-base-content">Errors only</span>
        <span className="text-[11px] text-base-content/50">
          {errorsOnly
            ? "Issues & errors only."
            : "All event types (comments, seer, builds, …)."}
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label="Errors only"
        className="toggle toggle-sm toggle-primary"
        checked={errorsOnly}
        onChange={(e) => onChange(e.target.checked ? [...ERROR_RESOURCES] : [])}
      />
    </label>
  );
}

/** "Production only" toggle: ON ⇒ prod environment globs; OFF ⇒ any env. */
function ProdOnlyToggle({
  environment,
  onChange,
}: {
  environment: string[];
  onChange: (next: string[]) => void;
}) {
  const prodOnly = environment.length > 0;
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="flex flex-col">
        <span className="text-sm font-medium text-base-content">Production only</span>
        <span className="text-[11px] text-base-content/50">
          {prodOnly ? "Only prod environments." : "Any environment (incl. staging/dev)."}
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label="Production only"
        className="toggle toggle-sm toggle-primary"
        checked={prodOnly}
        onChange={(e) => onChange(e.target.checked ? [...PROD_ENV_PATTERNS] : [])}
      />
    </label>
  );
}

/** Is the current value "match any"? Treats a literal `true` (legacy, was
 *  silently prod-only) as match-any too, so flipping the slider re-saves it as
 *  a real match-all and the routine starts firing on everything. */
function isSentryMatchAny(v: boolean | SentryRule): boolean {
  if (v === true) return true;
  if (typeof v !== "object") return false;
  return (
    v.resource.length === 0 &&
    v.project.length === 1 &&
    v.project[0] === "*" &&
    v.environment.length === 0 &&
    v.level.length === 0 &&
    v.action.length === 0 &&
    v.host.length === 0
  );
}

export function SentryHookEditor({
  value,
  onChange,
}: {
  value: boolean | SentryRule;
  onChange: (next: boolean | SentryRule) => void;
}) {
  const matchAny = isSentryMatchAny(value);
  const rule: SentryRule = typeof value === "object" ? value : defaultSentryRule();

  return (
    <div className="space-y-3">
      <MatchAnyToggle
        matchAny={matchAny}
        onMatchAny={() => onChange(sentryMatchAll())}
        onFilter={() => onChange(defaultSentryRule())}
        anyLabel="Match any Sentry event"
      />
      {!matchAny && (
        <div className="space-y-3">
          <ErrorsOnlyToggle
            resource={rule.resource}
            onChange={(next) => onChange({ ...rule, resource: next })}
          />
          <PillList
            label="Project"
            items={rule.project}
            placeholder="clara-backend, javascript-*"
            onChange={(next) => onChange({ ...rule, project: next })}
            hint="Project slugs. Glob patterns ok. * matches any project."
          />
          <ProdOnlyToggle
            environment={rule.environment}
            onChange={(next) => onChange({ ...rule, environment: next })}
          />
          <SeverityPills
            selected={rule.level}
            onChange={(next) => onChange({ ...rule, level: next })}
          />
          <PillList
            label="Action"
            items={rule.action}
            placeholder="created, resolved"
            onChange={(next) => onChange({ ...rule, action: next })}
            hint="Issue action (created, resolved, assigned, …). Empty matches any."
          />
          <PillList
            label="Host"
            items={rule.host}
            placeholder="d8d9e3ec*, !*-staging-*"
            onChange={(next) => onChange({ ...rule, host: next })}
            hint="server_name globs (error events only). Issue webhooks carry no host and always pass. Empty matches any."
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
