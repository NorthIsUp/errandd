// Wrapper around Darwin UI Input.

import { Input as DarwinInput } from "@pikoloo/darwin-ui";
import type { InputHTMLAttributes } from "react";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** "sm" constrains max-width to 160px (kept for compatibility) */
  sizeVariant?: "sm" | "full";
}

export function Input({ sizeVariant, className, ...rest }: Props) {
  const cls = [sizeVariant === "sm" ? "max-w-[160px]" : undefined, className]
    .filter(Boolean)
    .join(" ");
  if (cls) {
    return <DarwinInput className={cls} {...rest} />;
  }
  return <DarwinInput {...rest} />;
}
