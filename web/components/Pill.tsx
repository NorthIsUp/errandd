// Pill — outlined uppercase mono status pill using Darwin Badge.
// The user's favorite: green outlined uppercase mono (✓ CLEAN · PULLED 1M AGO).
// Darwin Badge with variant + extra classes for mono + uppercase + tone.

import { Badge as DarwinBadge } from "@pikoloo/darwin-ui";
import type { ReactNode } from "react";

type Tone = "good" | "warn" | "bad" | "accent" | "muted";
type Size = "sm" | "md";

type DarwinBadgeVariant =
  | "success"
  | "warning"
  | "destructive"
  | "info"
  | "outline";
const TONE_VARIANT: Record<Tone, DarwinBadgeVariant> = {
  good: "success",
  warn: "warning",
  bad: "destructive",
  accent: "info",
  muted: "outline",
};

interface Props {
  tone?: Tone;
  size?: Size;
  children: ReactNode;
  className?: string;
}

/**
 * Rounded-pill outline label, monospace uppercase.
 * Renders via Darwin Badge with mono/uppercase override.
 */
export function Pill({
  tone = "muted",
  size = "sm",
  children,
  className,
}: Props) {
  const sizeClass =
    size === "sm"
      ? "text-[9px] px-[5px] py-[1px]"
      : "text-[11px] px-[7px] py-[2px]";
  return (
    <DarwinBadge
      variant={TONE_VARIANT[tone]}
      style={{
        fontFamily: "var(--font-mono, monospace)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        border: "1px solid currentColor",
      }}
      className={[sizeClass, className].filter(Boolean).join(" ")}
    >
      {children}
    </DarwinBadge>
  );
}
