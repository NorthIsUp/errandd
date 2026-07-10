"use client";

import { Slot } from "@radix-ui/react-slot";
import * as React from "react";
import { cn } from "./utils";

// Minimal Collapsible primitive (no radix dep). Mirrors the
// @radix-ui/react-collapsible API surface that prompt-kit relies on:
// controlled (`open`/`onOpenChange`) or uncontrolled (`defaultOpen`), a
// trigger with `asChild`, and `data-state="open"|"closed"` on every part so
// `data-[state=open]` / `group-data-[state=open]` Tailwind variants resolve.

interface CollapsibleContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(
  null,
);

function useCollapsible(): CollapsibleContextValue {
  const ctx = React.useContext(CollapsibleContext);
  if (!ctx)
    throw new Error("Collapsible.* must be used inside <Collapsible>");
  return ctx;
}

export type CollapsibleProps = React.ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function Collapsible({
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
  ...props
}: CollapsibleProps) {
  const [internal, setInternal] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internal;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternal(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  return (
    <CollapsibleContext.Provider value={{ open: isOpen, setOpen }}>
      <div
        data-state={isOpen ? "open" : "closed"}
        className={className}
        {...props}
      >
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export type CollapsibleTriggerProps =
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
  };

const CollapsibleTrigger = React.forwardRef<
  HTMLButtonElement,
  CollapsibleTriggerProps
>(({ asChild = false, className, onClick, children, ...props }, ref) => {
  const { open, setOpen } = useCollapsible();
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      data-state={open ? "open" : "closed"}
      className={className}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e);
        setOpen(!open);
      }}
      {...props}
    >
      {children}
    </Comp>
  );
});
CollapsibleTrigger.displayName = "CollapsibleTrigger";

export type CollapsibleContentProps = React.ComponentProps<"div">;

function CollapsibleContent({
  className,
  children,
  ...props
}: CollapsibleContentProps) {
  const { open } = useCollapsible();
  // Only mount children while open. Previously children were always mounted and
  // merely `hidden` (display:none), so every collapsed block — Markdown bodies,
  // shiki-highlighted tool/code output, collapsed sidebar subtrees — stayed live
  // DOM, accumulating heavily over a long transcript. "Collapsed by default"
  // saved zero memory. (Safe: the collapsible-up/down keyframes resolve to
  // height:auto here — this primitive never sets --radix-collapsible-content-height
  // — and CSS can't animate to/from auto, so the animations were already no-ops.)
  return (
    <div
      data-state={open ? "open" : "closed"}
      hidden={!open}
      className={cn(className)}
      {...props}
    >
      {open ? children : null}
    </div>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
