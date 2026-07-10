import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class-name merge helper (shadcn `cn`), used throughout the vendored prompt-kit components. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
