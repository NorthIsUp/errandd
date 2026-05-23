import type { ReactNode } from "react";
import styles from "./Pill.module.css";

type Tone = "good" | "warn" | "bad" | "accent" | "muted";
type Size = "sm" | "md";

interface Props {
  tone?: Tone;
  size?: Size;
  children: ReactNode;
  className?: string;
}

/**
 * Rounded-pill outline label, monospace uppercase.
 * Use for status labels, kind badges, small categorical chips.
 * Children can include text, glyphs, and · separators.
 */
export function Pill({
  tone = "muted",
  size = "sm",
  children,
  className,
}: Props) {
  return (
    <span
      className={[styles.pill, styles[tone], styles[size], className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
