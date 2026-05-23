import type { InputHTMLAttributes } from "react";
import styles from "./Input.module.css";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  /** "sm" constrains max-width to 160px */
  sizeVariant?: "sm" | "full";
}

export function Input({ sizeVariant, className, ...rest }: Props) {
  return (
    <input
      className={[
        styles.input,
        sizeVariant === "sm" ? styles.sm : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}
