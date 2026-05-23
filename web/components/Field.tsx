import type { ReactNode } from "react";
import styles from "./Field.module.css";

interface Props {
  label: string;
  htmlFor?: string;
  layout?: "row" | "col";
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  htmlFor,
  layout = "row",
  className,
  children,
}: Props) {
  return (
    <div
      className={[
        styles.field,
        layout === "col" ? styles.col : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is conditionally passed by callers that pair this with an input */}
      <label
        className={styles.label ?? ""}
        {...(htmlFor !== undefined ? { htmlFor } : {})}
      >
        {label}
      </label>
      <div className={styles.control}>{children}</div>
    </div>
  );
}
