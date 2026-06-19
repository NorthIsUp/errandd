import { Bug, CalendarClock, GitPullRequest, LineChart, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  type DatadogRule,
  defaultDatadogRule,
  defaultPrRule,
  defaultSentryRule,
  type HookConfig,
  type SentryRule,
} from "../hookConfig";
import type { JobFrontmatter } from "../schedule";
import { Card } from "./Card";
import { HookConfigEditor } from "./HookConfigEditor";
import { DatadogHookEditor, SentryHookEditor } from "./ProviderHookEditor";
import { ScheduleEditor } from "./ScheduleEditor";

/**
 * Unified editor for everything that can fire a routine: cron schedules
 * and event hooks (GitHub, Sentry, Datadog). Subsections stack vertically
 * inside one logical "Triggers" group, with explicit
 * `+ schedule / + gh hook / + sentry hook / + dd hook` buttons up top.
 *
 * Frontmatter contract is unchanged — this is a presentational regrouping
 * over the existing ScheduleEditor / HookConfigEditor components plus the
 * Sentry / Datadog editors, all of which read/write the same HookConfig.
 *
 * Composes:
 *   - <ScheduleEditor>      for the cron / preset / recurring fields
 *   - <HookConfigEditor>    for the on.pr / on.comments block
 *   - <SentryHookEditor>    for the on.sentry block
 *   - <DatadogHookEditor>   for the on.datadog block
 *
 * Enabled and Notify live at the top/bottom — they're routine-wide
 * settings, not triggers.
 */
export function TriggersEditor({
  value,
  onChange,
}: {
  value: JobFrontmatter;
  onChange: (next: JobFrontmatter) => void;
}) {
  const cfg = value.hookConfig;

  const schedules = value.schedules;
  const scheduleActive = schedules.length > 0;
  const ghHookActive =
    (cfg?.pr.length ?? 0) > 0 ||
    cfg?.comments === true ||
    (typeof cfg?.comments === "object" && cfg?.comments !== null);
  const sentryActive = cfg?.sentry !== undefined && cfg?.sentry !== false;
  const datadogActive = cfg?.datadog !== undefined && cfg?.datadog !== false;

  function addSchedule() {
    // Default to a sensible preset — every 5 minutes — so the editor
    // isn't empty. The user can immediately retune via the slider.
    onChange({ ...value, schedules: [...schedules, "*/5 * * * *"] });
  }

  function updateScheduleAt(i: number, cron: string) {
    const next = schedules.slice();
    next[i] = cron;
    onChange({ ...value, schedules: next });
  }

  function removeScheduleAt(i: number) {
    const next = schedules.filter((_, j) => j !== i);
    // Drop the now-meaningless recurring flag once the last schedule goes.
    onChange({ ...value, schedules: next, recurring: next.length > 0 ? value.recurring : null });
  }

  /** Apply a mutation to a draft HookConfig, then persist — dropping the
   *  whole block when no trigger remains so empty `on:` blocks aren't
   *  written. The draft is a fresh copy so callers can freely delete keys
   *  (needed under exactOptionalPropertyTypes). */
  function mutateHookConfig(fn: (draft: HookConfig) => void) {
    const draft: HookConfig = cfg ? { ...cfg, pr: [...cfg.pr] } : { skipSelf: true, pr: [] };
    fn(draft);
    const commentsActive =
      draft.comments === true || (typeof draft.comments === "object" && draft.comments !== null);
    const anyTrigger =
      draft.pr.length > 0 ||
      commentsActive ||
      (draft.sentry !== undefined && draft.sentry !== false) ||
      (draft.datadog !== undefined && draft.datadog !== false);
    onChange({ ...value, hookConfig: anyTrigger ? draft : null });
  }

  function addGhHook() {
    // Seed a single empty PR rule so HookConfigEditor lights up with a
    // RuleCard the user can fill in.
    mutateHookConfig((d) => {
      d.pr = [defaultPrRule()];
    });
  }

  function removeGhHook() {
    // Drop the GitHub-specific fields but keep any sentry/datadog blocks.
    mutateHookConfig((d) => {
      d.pr = [];
      delete d.comments;
    });
  }

  function addSentryHook() {
    mutateHookConfig((d) => {
      d.sentry = defaultSentryRule();
    });
  }

  function removeSentryHook() {
    mutateHookConfig((d) => {
      delete d.sentry;
    });
  }

  function addDatadogHook() {
    mutateHookConfig((d) => {
      d.datadog = defaultDatadogRule();
    });
  }

  function removeDatadogHook() {
    mutateHookConfig((d) => {
      delete d.datadog;
    });
  }

  const noTriggers = !(scheduleActive || ghHookActive || sentryActive || datadogActive);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold mr-1">Triggers</h3>
        {/* Multiple schedules are allowed — the routine fires when any cron
            is due — so this button stays available. */}
        <button type="button" className="btn btn-xs btn-outline" onClick={addSchedule}>
          <Plus size={12} /> schedule
        </button>
        {!ghHookActive && (
          <button type="button" className="btn btn-xs btn-outline" onClick={addGhHook}>
            <Plus size={12} /> gh hook
          </button>
        )}
        {!sentryActive && (
          <button type="button" className="btn btn-xs btn-outline" onClick={addSentryHook}>
            <Plus size={12} /> sentry hook
          </button>
        )}
        {!datadogActive && (
          <button type="button" className="btn btn-xs btn-outline" onClick={addDatadogHook}>
            <Plus size={12} /> dd hook
          </button>
        )}
      </div>

      {noTriggers && (
        <p className="text-xs text-base-content/60 italic">
          No triggers yet. Add a schedule to run on a cron, or a hook to fire on events.
        </p>
      )}

      {schedules.map((cron, i) => (
        <TriggerSubsection
          // biome-ignore lint/suspicious/noArrayIndexKey: schedules are positional with no stable id; index is the identity here
          key={`schedule-${i}`}
          icon={<CalendarClock size={14} className="opacity-70" />}
          label={schedules.length > 1 ? `Schedule ${i + 1}` : "Schedule"}
          onRemove={() => removeScheduleAt(i)}
        >
          <ScheduleEditor cron={cron} onChange={(next) => updateScheduleAt(i, next)} />
        </TriggerSubsection>
      ))}

      {scheduleActive && (
        <label className="flex items-center gap-3 cursor-pointer px-1">
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={value.recurring ?? false}
            onChange={(e) => onChange({ ...value, recurring: e.target.checked })}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">Recurring</div>
            <div className="text-xs text-base-content/60">
              Re-arm after each run instead of firing once. Applies to all schedules.
            </div>
          </div>
        </label>
      )}

      {ghHookActive && (
        <TriggerSubsection
          icon={<GitPullRequest size={14} className="opacity-70" />}
          label="GitHub hooks"
          onRemove={removeGhHook}
        >
          <HookConfigEditor
            value={value.hookConfig}
            onChange={(next) =>
              // The GitHub editor only knows about pr/comments/skipSelf; it
              // returns null when both are empty. Preserve sentry/datadog by
              // merging instead of blindly replacing the whole block.
              mutateHookConfig((d) => {
                d.pr = next?.pr ?? [];
                if (next?.comments === undefined) {
                  delete d.comments;
                } else {
                  d.comments = next.comments;
                }
                d.skipSelf = next?.skipSelf ?? d.skipSelf ?? true;
              })
            }
          />
        </TriggerSubsection>
      )}

      {sentryActive && cfg?.sentry !== undefined && (
        <TriggerSubsection
          icon={<Bug size={14} className="opacity-70" />}
          label="Sentry hooks"
          onRemove={removeSentryHook}
        >
          <SentryHookEditor
            value={cfg.sentry}
            onChange={(next) =>
              mutateHookConfig((d) => {
                d.sentry = next;
              })
            }
          />
        </TriggerSubsection>
      )}

      {datadogActive && cfg?.datadog !== undefined && (
        <TriggerSubsection
          icon={<LineChart size={14} className="opacity-70" />}
          label="Datadog hooks"
          onRemove={removeDatadogHook}
        >
          <DatadogHookEditor
            value={cfg.datadog}
            onChange={(next) =>
              mutateHookConfig((d) => {
                d.datadog = next;
              })
            }
          />
        </TriggerSubsection>
      )}
    </section>
  );
}

function TriggerSubsection({
  icon,
  label,
  onRemove,
  children,
}: {
  icon: ReactNode;
  label: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
          {icon}
          {label}
        </span>
      }
      actions={
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
        >
          <Trash2 size={14} />
        </button>
      }
    >
      {children}
    </Card>
  );
}
