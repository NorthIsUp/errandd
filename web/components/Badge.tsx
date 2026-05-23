// Wrapper around Darwin UI Badge that maps our old variant names.

import { Badge as DarwinBadge } from "@pikoloo/darwin-ui";
import type { ReactNode } from "react";

type OurVariant = "muted" | "accent" | "warn" | "good" | "bad";

interface Props {
  variant?: OurVariant;
  className?: string;
  children: ReactNode;
}

const VARIANT_MAP: Record<
  OurVariant,
  "secondary" | "info" | "warning" | "success" | "destructive"
> = {
  muted: "secondary",
  accent: "info",
  warn: "warning",
  good: "success",
  bad: "destructive",
};

export function Badge({ variant = "muted", className, children }: Props) {
  return (
    <DarwinBadge variant={VARIANT_MAP[variant]} className={className}>
      {children}
    </DarwinBadge>
  );
}
