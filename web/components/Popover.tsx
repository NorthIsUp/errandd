// Wrapper around Darwin UI Popover.

import {
  Popover as DarwinPopover,
  PopoverContent,
  PopoverTrigger,
} from "@pikoloo/darwin-ui";
import type { ReactNode } from "react";

interface Props {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  children: ReactNode;
}

export function Popover({
  open,
  onOpenChange,
  trigger,
  side = "top",
  align = "start",
  sideOffset = 4,
  className,
  children,
}: Props) {
  const rootProps: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  } = {};
  if (open !== undefined) rootProps.open = open;
  if (onOpenChange !== undefined) rootProps.onOpenChange = onOpenChange;

  const contentProps: {
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    sideOffset?: number;
    className?: string;
  } = { side, align, sideOffset };
  if (className) contentProps.className = className;

  return (
    <DarwinPopover {...rootProps}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent {...contentProps}>{children}</PopoverContent>
    </DarwinPopover>
  );
}
