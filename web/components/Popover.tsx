import * as RadixPopover from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import styles from "./Popover.module.css";

interface Props {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger element */
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
  return (
    <RadixPopover.Root
      {...(open !== undefined && onOpenChange !== undefined
        ? { open, onOpenChange }
        : open !== undefined
          ? { open }
          : onOpenChange !== undefined
            ? { onOpenChange }
            : {})}
    >
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className={[styles.content, className].filter(Boolean).join(" ")}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
          }}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
