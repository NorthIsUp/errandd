import type { ReactNode } from "react";
import styles from "./Badge.module.css";

type Variant = "muted" | "accent" | "warn" | "good" | "bad";

interface Props {
  variant?: Variant;
  className?: string;
  children: ReactNode;
}

export function Badge({ variant = "muted", className, children }: Props) {
  return (
    <span
      className={[styles.badge, styles[variant], className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
