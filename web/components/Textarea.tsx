// Wrapper around Darwin UI Textarea.

import { Textarea as DarwinTextarea } from "@pikoloo/darwin-ui";
import type { TextareaHTMLAttributes } from "react";

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** "chat" = transparent/no-border variant for the chat input area */
  variant?: "default" | "chat";
}

export function Textarea({ variant = "default", className, ...rest }: Props) {
  // "chat" variant: pass a custom class to make it transparent/minimal
  const cls = [
    variant === "chat"
      ? "bg-transparent border-0 shadow-none resize-none"
      : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <DarwinTextarea className={cls || undefined} {...rest} />;
}
