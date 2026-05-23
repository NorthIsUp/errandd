import type { SelectHTMLAttributes } from "react";
import styles from "./Select.module.css";

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {}

export function Select({ className, ...rest }: Props) {
  return (
    <select
      className={[styles.select, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}
