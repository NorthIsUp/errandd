import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { PRESETS, presetIndexForCron } from "../schedule";
import { FrequencySlider } from "./FrequencySlider";

/**
 * Edit a single cron expression. Pure controlled component — the parent
 * (TriggersEditor) owns the list of schedules and the recurring flag.
 *
 * Renders a frequency slider (preset cron stops) plus a collapsible advanced
 * cron input. Recurring / notify / hook config live in TriggersEditor.
 */
export function ScheduleEditor({
  cron,
  onChange,
}: {
  cron: string;
  onChange: (cron: string) => void;
}) {
  const presetIndex = presetIndexForCron(cron);
  const [advanced, setAdvanced] = useState(presetIndex < 0);
  const safeIndex = presetIndex < 0 ? 0 : presetIndex;

  function selectPreset(i: number) {
    const preset = PRESETS[i];
    if (!preset) {
      return;
    }
    onChange(preset.cron);
  }

  return (
    <div className="space-y-3">
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
            value={cron}
            onChange={(e) => onChange(e.target.value)}
            placeholder="* * * * *"
            aria-label="Cron expression"
          />
        )}
      </div>
    </div>
  );
}
