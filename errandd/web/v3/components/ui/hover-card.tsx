"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import { cn } from "./utils";

// HoverCard built on radix Popover (no separate @radix-ui/react-hover-card
// dependency). Opens on pointer-enter / focus with configurable delays, which
// is all prompt-kit's `source` component needs.

interface HoverCardContextValue {
  open: boolean;
  setOpenDelayed: (open: boolean) => void;
  bindHoverHandlers: boolean;
}

const HoverCardContext = React.createContext<HoverCardContextValue | null>(
  null,
);

export interface HoverCardProps {
  children: React.ReactNode;
  openDelay?: number;
  closeDelay?: number;
}

function HoverCard({
  children,
  openDelay = 200,
  closeDelay = 150,
}: HoverCardProps) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const setOpenDelayed = React.useCallback(
    (next: boolean) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => setOpen(next),
        next ? openDelay : closeDelay,
      );
    },
    [openDelay, closeDelay],
  );

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <HoverCardContext.Provider
      value={{ open, setOpenDelayed, bindHoverHandlers: true }}
    >
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        {children}
      </PopoverPrimitive.Root>
    </HoverCardContext.Provider>
  );
}

export type HoverCardTriggerProps = React.ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Trigger
>;

const HoverCardTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  HoverCardTriggerProps
>((props, ref) => {
  const ctx = React.useContext(HoverCardContext);
  return (
    <PopoverPrimitive.Trigger
      ref={ref}
      onPointerEnter={() => ctx?.setOpenDelayed(true)}
      onPointerLeave={() => ctx?.setOpenDelayed(false)}
      onFocus={() => ctx?.setOpenDelayed(true)}
      onBlur={() => ctx?.setOpenDelayed(false)}
      {...props}
    />
  );
});
HoverCardTrigger.displayName = "HoverCardTrigger";

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => {
  const ctx = React.useContext(HoverCardContext);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={() => ctx?.setOpenDelayed(true)}
        onPointerLeave={() => ctx?.setOpenDelayed(false)}
        className={cn(
          "z-50 w-64 rounded-md border border-base-300 bg-base-100 p-4 text-base-content shadow-md outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
HoverCardContent.displayName = "HoverCardContent";

export { HoverCard, HoverCardTrigger, HoverCardContent };
