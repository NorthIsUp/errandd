import { PRESETS } from "../schedule";

/**
 * A discrete slider over the schedule presets — always snaps to a preset.
 */
export function FrequencySlider({
  value,
  onChange,
}: {
  /** Index into PRESETS. */
  value: number;
  onChange: (index: number) => void;
}) {
  const max = PRESETS.length - 1;

  // DaisyUI `range-sm`'s thumb is ~1rem; half = 0.5rem of inset on each side
  // so absolute-positioned ticks (placed at left: i/max * 100%) line up with
  // the thumb's actual centre at each step.
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-base-content/60 px-2">
        <span>faster</span>
        <span>slower</span>
      </div>

      <div className="px-2">
        <input
          type="range"
          className="range range-primary range-sm w-full"
          min={0}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Schedule frequency"
          aria-valuetext={PRESETS[value]?.human ?? ""}
        />
      </div>

      <div className="relative h-8 mx-2 select-none text-[10px] text-base-content/60">
        {PRESETS.map((p, i) => (
          <button
            key={p.minutes}
            type="button"
            style={{ left: `${(i / max) * 100}%` }}
            className={`absolute top-0 -translate-x-1/2 flex flex-col items-center gap-0.5 px-1 ${
              i === value ? "text-primary font-semibold" : "hover:text-base-content"
            }`}
            onClick={() => onChange(i)}
            aria-label={`Set to ${p.human}`}
          >
            <span aria-hidden className="text-base-content/40 leading-none">
              {i === value ? "●" : "·"}
            </span>
            <span className="leading-none">{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
