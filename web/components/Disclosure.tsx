// Wrapper around Darwin UI Accordion for our simple Disclosure API.

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@pikoloo/darwin-ui";
import type { ReactNode } from "react";

interface Props {
  label: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}

export function Disclosure({
  label,
  defaultOpen = false,
  className,
  children,
}: Props) {
  const accordionProps = defaultOpen
    ? { type: "single" as const, defaultValue: "item" }
    : { type: "single" as const };
  const cls = className ?? undefined;
  return (
    <Accordion {...accordionProps} {...(cls ? { className: cls } : {})}>
      <AccordionItem value="item">
        <AccordionTrigger>{label}</AccordionTrigger>
        <AccordionContent>{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
