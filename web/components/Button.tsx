// Re-export Darwin UI Button as our Button component.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export { Button } from "@pikoloo/darwin-ui";

// ButtonProps is not exported by Darwin UI, so define a compatible type here.
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "default"
    | "primary"
    | "secondary"
    | "success"
    | "warning"
    | "info"
    | "destructive"
    | "outline"
    | "ghost"
    | "link"
    | "accent";
  size?: "default" | "sm" | "lg" | "icon";
  loading?: boolean;
  loadingText?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
  iconOnly?: boolean;
  glass?: boolean;
  children?: ReactNode;
}
