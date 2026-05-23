import styles from "./Spinner.module.css";

type Size = "sm" | "md" | "lg";

interface Props {
  size?: Size;
  className?: string;
  label?: string;
}

export function Spinner({ size = "md", className, label = "Loading…" }: Props) {
  return (
    <span
      role="status"
      aria-label={label}
      className={[
        styles.spinner,
        size !== "md" ? styles[size] : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
