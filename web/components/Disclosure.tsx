import type { ReactNode } from "react";
import { useState } from "react";
import styles from "./Disclosure.module.css";

interface Props {
  label: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}

export function Disclosure({
  label,
  defaultOpen = false,
  className,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className={[styles.disclosure, open ? styles.open : undefined, className]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className={styles.header}
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <span className={styles.caret}>▶</span>
        <span className={styles.label}>{label}</span>
      </button>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
