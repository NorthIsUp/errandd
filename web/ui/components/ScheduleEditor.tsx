import { ChevronDown, ChevronRight, PlugZap } from "lucide-react";
import { useState } from "react";
import { type JobFrontmatter, PRESETS, presetIndexForCron } from "../schedule";
import { FrequencySlider } from "./FrequencySlider";
import { HookConfigEditor } from "./HookConfigEditor";

/**
 * Edit the schedule-relevant frontmatter for a job. Pure controlled
 * component — the parent owns the JobFrontmatter draft and the save action.
 *
 * Sections are visually separated by `<hr>` so the editor reads as:
 *   1. Enabled
 *   2a. Schedule (frequency + cron + recurring)
 *   2b. Hook config (TBD — placeholder for the PR-hooks spec)
 *   3. Notify
 */
export function ScheduleEditor({
  value,
  onChange,
}: {
  value: JobFrontmatter;
  onChange: (next: JobFrontmatter) => void;
}) {
  const [advanced, setAdvanced] = useState(presetIndexForCron(value.schedule) < 0);

  const presetIndex = presetIndexForCron(value.schedule);
  const safeIndex = presetIndex < 0 ? 0 : presetIndex;

  function selectPreset(i: number) {
    const preset = PRESETS[i];
    if (!preset) {
      return;
    }
    onChange({ ...value, schedule: preset.cron });
  }

  return (
    <div className="space-y-5">
      {/* 1. Enabled — top-level on/off for the routine. */}
      <section>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={value.enabled ?? true}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">Enabled</div>
            <div className="text-xs text-base-content/60">
              Off keeps the file but skips scheduling and hooks.
            </div>
          </div>
        </label>
      </section>

      <hr className="border-base-300" />

      {/* 2a. Schedule. */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Schedule</h3>
        {presetIndex < 0 ? (
          <p className="text-xs text-base-content/60 italic">
            This schedule doesn’t match a preset. Use Advanced cron below to edit.
          </p>
        ) : (
          <FrequencySlider value={safeIndex} onChange={selectPreset} />
        )}

        <div>
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            className="inline-flex items-center gap-1 text-sm font-medium text-base-content/80 hover:text-base-content"
            aria-expanded={advanced}
          >
            {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Advanced cron
          </button>
          {advanced && (
            <input
              type="text"
              spellCheck={false}
              className="input input-bordered input-sm font-mono w-full mt-2"
              value={value.schedule}
              onChange={(e) => onChange({ ...value, schedule: e.target.value })}
              placeholder="* * * * *"
              aria-label="Cron expression"
            />
          )}
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={value.recurring ?? false}
            onChange={(e) => onChange({ ...value, recurring: e.target.checked })}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">Recurring</div>
            <div className="text-xs text-base-content/60">
              Re-arm after each run instead of firing once.
            </div>
          </div>
        </label>
      </section>

      <hr className="border-base-300" />

      {/* 2b. Hook config — event-driven triggers (GitHub PRs). */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold inline-flex items-center gap-1.5">
          <PlugZap size={14} className="opacity-70" />
          Hook config
        </h3>
        <p className="text-xs text-base-content/60">
          Fire this routine when a matching GitHub pull-request event arrives.
        </p>
        <HookConfigEditor
          value={value.hookConfig}
          onChange={(next) => onChange({ ...value, hookConfig: next })}
        />
      </section>

      <hr className="border-base-300" />

      {/* 3. Notify. */}
      <section>
        <fieldset>
          <legend className="text-sm font-semibold mb-1">Notify on</legend>
          <div className="join">
            {(["true", "error", "false"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                aria-pressed={(value.notify ?? "false") === opt}
                onClick={() => onChange({ ...value, notify: opt })}
                className={`btn btn-sm join-item ${
                  (value.notify ?? "false") === opt ? "btn-primary" : "btn-ghost"
                }`}
              >
                {opt === "true" ? "Always" : opt === "error" ? "On error" : "Never"}
              </button>
            ))}
          </div>
        </fieldset>
      </section>
    </div>
  );
}
