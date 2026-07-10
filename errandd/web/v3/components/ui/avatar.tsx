"use client";

import * as React from "react";
import { cn } from "./utils";

// Lightweight Avatar (no @radix-ui/react-avatar dependency). Renders the image
// and falls back to children if the image fails or none is supplied. Matches
// the API surface prompt-kit's `message` component uses.

export type AvatarProps = React.HTMLAttributes<HTMLSpanElement>;

function Avatar({ className, children, ...props }: AvatarProps) {
  return (
    <span
      className={cn(
        "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full bg-base-300",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export type AvatarImageProps = React.ImgHTMLAttributes<HTMLImageElement>;

function AvatarImage({ className, alt, ...props }: AvatarImageProps) {
  const [failed, setFailed] = React.useState(false);
  if (failed || !props.src) return null;
  return (
    <img
      alt={alt}
      className={cn("aspect-square h-full w-full object-cover", className)}
      onError={() => setFailed(true)}
      {...props}
    />
  );
}

export type AvatarFallbackProps = React.HTMLAttributes<HTMLSpanElement> & {
  delayMs?: number | undefined;
};

function AvatarFallback({
  className,
  children,
  delayMs,
  ...props
}: AvatarFallbackProps) {
  void delayMs;
  return (
    <span
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-base-300 text-base-content text-sm",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export { Avatar, AvatarImage, AvatarFallback };
