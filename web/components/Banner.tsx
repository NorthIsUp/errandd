// Banner/BannerRow — session prefs display above chat input.
// Using Darwin glass aesthetic via inline styles that match the dark theme.
import type { ReactNode } from "react";

interface BannerRowProps {
  label: string;
  onClose?: () => void;
  children: ReactNode;
}

export function BannerRow({ label, onClose, children }: BannerRowProps) {
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
      {onClose !== undefined && (
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
      )}
    </div>
  );
}

interface Props {
  className?: string;
  children: ReactNode;
}

export function Banner({ className, children }: Props) {
  return (
    <div
      className={className}
      style={{
        background: "rgba(11, 18, 32, 0.8)",
        border: "1px solid rgba(216, 228, 255, 0.12)",
        borderRadius: "8px",
        overflow: "hidden",
        margin: "0 8px 8px",
        backdropFilter: "blur(8px)",
      }}
    >
      {children}
    </div>
  );
}
