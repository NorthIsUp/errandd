import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import "./copy-button.css";

/** Place inside the positioned box whose exact text is copied. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const title =
    state === "copied"
      ? "Copied"
      : state === "failed"
        ? "Copy failed — try again"
        : `Copy ${label}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <button
      type="button"
      className="errandd-copy-button"
      aria-label={title}
      title={title}
      onClick={() => {
        void copy();
      }}
    >
      {state === "copied" ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  );
}
