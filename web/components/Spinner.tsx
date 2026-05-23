// Spinner using Darwin UI's CircularProgress in indeterminate mode.
import { CircularProgress } from "@pikoloo/darwin-ui";

type Size = "sm" | "md" | "lg";

const SIZE_PX: Record<Size, number> = {
  sm: 14,
  md: 20,
  lg: 32,
};

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
      className={className}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      <CircularProgress
        indeterminate
        size={SIZE_PX[size]}
        strokeWidth={size === "sm" ? 2 : 3}
      />
    </span>
  );
}
