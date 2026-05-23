import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

interface Props {
  message: string;
  cta?: ReactNode;
  className?: string;
}

export function EmptyState({ message, cta, className }: Props) {
  return (
    <div className={[styles.empty, className].filter(Boolean).join(" ")}>
      <p className={styles.message}>{message}</p>
      {cta !== undefined && <div className={styles.cta}>{cta}</div>}
    </div>
  );
}
