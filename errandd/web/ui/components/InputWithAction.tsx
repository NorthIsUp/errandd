import type React from "react";

/**
 * A text input joined visually to a trailing icon button (e.g. a delete
 * affordance). The button shares the input's `border-base-300` color so
 * the pair reads as one continuous control rather than an input plus a
 * separate, more weighty button.
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
    title?: string;
  };
}) {
  const sizeCls = size === "sm" ? "input-sm" : "";
  const btnSizeCls = size === "sm" ? "btn-sm" : "";
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
        // `btn-ghost` strips daisyUI's coloured outline; the explicit
        // `border-base-300` aligns the button's edge with the input's so
        // the pair reads as a single bordered control.
        className={`btn btn-ghost join-item border border-base-300 text-base-content/70 hover:text-base-content ${btnSizeCls}`}
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
