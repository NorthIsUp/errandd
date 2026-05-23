// Wrapper around Darwin UI Tooltip.

import {
  Tooltip as DarwinTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@pikoloo/darwin-ui";
import type { ReactNode } from "react";

interface Props {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}

export function Tooltip({ label, side = "top", children }: Props) {
  return (
    <TooltipProvider>
      <DarwinTooltip delayDuration={400}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={6}>
          {label}
        </TooltipContent>
      </DarwinTooltip>
    </TooltipProvider>
  );
}
