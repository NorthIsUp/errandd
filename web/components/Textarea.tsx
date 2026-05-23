import type { TextareaHTMLAttributes } from "react";
import styles from "./Textarea.module.css";

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** "chat" = transparent/no-border variant for the chat input area */
  variant?: "default" | "chat";
}

export function Textarea({ variant = "default", className, ...rest }: Props) {
  return (
    <textarea
      className={[
        styles.textarea,
        variant === "chat" ? styles.chat : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}
