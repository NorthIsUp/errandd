import type { ReactNode } from "react";
import styles from "./Card.module.css";

interface Props {
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Card({ title, className, children }: Props) {
  return (
    <div className={[styles.card, className].filter(Boolean).join(" ")}>
      {title !== undefined && <h2 className={styles.title}>{title}</h2>}
      <div className={styles.body}>{children}</div>
    </div>
  );
}
