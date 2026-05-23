import * as RadixToast from "@radix-ui/react-toast";
import type { ReactNode } from "react";
import styles from "./Toast.module.css";

type Variant = "default" | "good" | "bad" | "warn";

interface ToastItemProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  variant?: Variant;
}

export function ToastItem({
  open,
  onOpenChange,
  title,
  description,
  variant = "default",
}: ToastItemProps) {
  return (
    <RadixToast.Root
      open={open}
      onOpenChange={onOpenChange}
      className={[
        styles.root,
        variant !== "default" ? styles[variant] : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div style={{ flex: 1 }}>
        <RadixToast.Title className={styles.title}>{title}</RadixToast.Title>
        {description !== undefined && (
          <RadixToast.Description className={styles.description}>
            {description}
          </RadixToast.Description>
        )}
      </div>
      <RadixToast.Close className={styles.close} aria-label="Dismiss">
        ×
      </RadixToast.Close>
    </RadixToast.Root>
  );
}

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  return (
    <RadixToast.Provider swipeDirection="right">
      {children}
      <RadixToast.Viewport className={styles.viewport} />
    </RadixToast.Provider>
  );
}
