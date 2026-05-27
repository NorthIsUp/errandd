import type React from "react";

/**
 * A text input joined visually to a trailing icon button (e.g. a delete
 * affordance). Encapsulates the daisyUI `join` pattern so callers stop
 * hand-rolling matching border treatments.
 *
 * Uses `border-base-300` to soften the input outline relative to daisyUI's
 * default (which mixes `--color-base-content` and reads as near-black in
 * the lobster theme). The action button gets `btn-outline btn-primary` so
 * the icon sits inside a real button — not a floating glyph next to a
 * heavy-bordered field.
 */
export function InputWithAction({
  value,
  onChange,
  placeholder,
  aria,
  type = "text",
  mono = false,
  size = "md",
  disabled,
  action,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Required — accessible label for the input itself. */
  aria: string;
  type?: "text" | "url" | "email" | "password";
  /** Apply monospaced font (URLs, slugs, etc.). */
  mono?: boolean;
  size?: "sm" | "md";
  disabled?: boolean;
  action: {
    icon: React.ReactNode;
    onClick: () => void;
    /** Accessible label for the trailing button. */
    aria: string;
    /** Visual treatment. Defaults to "outline" for parity with the input. */
    variant?: "outline" | "ghost" | "error";
    title?: string;
  };
}) {
  const sizeCls = size === "sm" ? "input-sm" : "";
  const btnSizeCls = size === "sm" ? "btn-sm" : "";
  const variant = action.variant ?? "outline";
  const btnVariantCls =
    variant === "ghost"
      ? "btn-ghost"
      : variant === "error"
        ? "btn-outline btn-error"
        : "btn-outline";
  return (
    <div className="join w-full">
      <input
        type={type}
        className={`input join-item flex-1 border-base-300 ${sizeCls} ${
          mono ? "font-mono text-sm" : ""
        }`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={aria}
        disabled={disabled}
      />
      <button
        type="button"
        className={`btn join-item ${btnSizeCls} ${btnVariantCls}`}
        onClick={action.onClick}
        aria-label={action.aria}
        disabled={disabled}
        title={action.title}
      >
        {action.icon}
      </button>
    </div>
  );
}
