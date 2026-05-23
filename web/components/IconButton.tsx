// Wrapper around Darwin UI's Button with iconOnly=true.

import { Button } from "@pikoloo/darwin-ui";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "default" | "accent" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

type DarwinVariant = "default" | "accent" | "destructive" | "ghost";
const VARIANT_MAP: Record<Variant, DarwinVariant> = {
  default: "default",
  accent: "accent",
  danger: "destructive",
  ghost: "ghost",
};

type DarwinSize = "sm" | "default" | "lg";
const SIZE_MAP: Record<Size, DarwinSize> = {
  sm: "sm",
  md: "default",
  lg: "lg",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  label: string; // accessible label (aria-label)
  children: ReactNode;
}

export function IconButton({
  variant = "default",
  size = "md",
  label,
  className,
  children,
  type = "button",
  ...rest
}: Props) {
  const extraProps = className ? { className } : {};
  return (
    <Button
      type={type}
      aria-label={label}
      variant={VARIANT_MAP[variant]}
      size={SIZE_MAP[size]}
      iconOnly
      {...extraProps}
      {...rest}
    >
      {children}
    </Button>
  );
}
