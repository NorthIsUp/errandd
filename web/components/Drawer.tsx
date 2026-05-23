// Wrapper around Darwin UI Dialog used as a mobile slide-in drawer.

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@pikoloo/darwin-ui";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Accessible title (visually hidden but required for a11y) */
  title: string;
  children: ReactNode;
}

export function Drawer({ open, onClose, title, children }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent glass size="sm">
        <DialogHeader>
          <DialogTitle className="sr-only">{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
