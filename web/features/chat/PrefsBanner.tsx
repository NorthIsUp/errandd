interface BannerRowProps {
  label: string;
  onClose: () => void;
  children: string;
}

function BannerRow({ label, onClose, children }: BannerRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "4px 10px",
        fontSize: "11px",
        borderBottom: "1px solid rgba(216, 228, 255, 0.08)",
      }}
    >
      <span
        style={{
          color: "var(--muted, #a8b4c5)",
          fontFamily: "var(--font-mono, monospace)",
          textTransform: "uppercase",
          fontSize: "9px",
          letterSpacing: "0.08em",
          minWidth: "44px",
        }}
      >
        {label}
      </span>
      <span
        style={{ flex: 1, color: "var(--text, #f0f4fb)", fontSize: "11px" }}
      >
        {children}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Clear ${label}`}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--muted, #a8b4c5)",
          fontSize: "14px",
          lineHeight: 1,
          padding: "0 2px",
          opacity: 0.7,
        }}
      >
        ×
      </button>
    </div>
  );
}

interface Props {
  goal?: string;
  model?: string;
  effort?: string;
  onClearGoal: () => void;
  onClearModel: () => void;
  onClearEffort: () => void;
}

/**
 * Session prefs banner — shows goal/model/effort rows above the chat input.
 * Ported from src/ui/page/script.ts `updatePrefsBanner`, `updateGoalBanner`, etc.
 */
export function PrefsBanner({
  goal,
  model,
  effort,
  onClearGoal,
  onClearModel,
  onClearEffort,
}: Props) {
  if (!goal && !model && !effort) return null;

  return (
    <div
      style={{
        background: "rgba(11, 18, 32, 0.8)",
        border: "1px solid rgba(216, 228, 255, 0.12)",
        borderRadius: "8px",
        overflow: "hidden",
        margin: "0 8px 8px",
        backdropFilter: "blur(8px)",
      }}
    >
      {goal && (
        <BannerRow label="goal" onClose={onClearGoal}>
          {goal}
        </BannerRow>
      )}
      {model && (
        <BannerRow label="model" onClose={onClearModel}>
          {model}
        </BannerRow>
      )}
      {effort && (
        <BannerRow label="effort" onClose={onClearEffort}>
          {effort}
        </BannerRow>
      )}
    </div>
  );
}
