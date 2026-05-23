// Wrapper around Darwin UI Card that maintains our old API (title prop).

import {
  CardContent,
  CardHeader,
  CardTitle,
  Card as DarwinCard,
} from "@pikoloo/darwin-ui";
import type { ReactNode } from "react";

interface Props {
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Card({ title, className, children }: Props) {
  return (
    <DarwinCard glass className={className}>
      {title !== undefined && (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </DarwinCard>
  );
}

// Also re-export Darwin sub-components for direct use
export {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@pikoloo/darwin-ui";
