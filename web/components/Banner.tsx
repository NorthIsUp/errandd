import type { ReactNode } from "react";
import styles from "./Banner.module.css";

interface BannerRowProps {
  label: string;
  onClose?: () => void;
  children: ReactNode;
}

export function BannerRow({ label, onClose, children }: BannerRowProps) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.content}>{children}</span>
      {onClose !== undefined && (
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label={`Clear ${label}`}
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
    <div className={[styles.banner, className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
