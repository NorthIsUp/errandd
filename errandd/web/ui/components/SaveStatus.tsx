import { Check, CircleAlert, Loader2 } from "lucide-react";
import type { AutosaveStatus } from "../useAutosave";

export function SaveStatus({ status }: { status: AutosaveStatus }) {
  if (status === "saving") {
    return (
      <span className="text-xs text-base-content/60 inline-flex items-center gap-1">
        <Loader2 size={12} className="animate-spin" /> Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="text-xs text-success inline-flex items-center gap-1">
        <Check size={12} /> Saved
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="text-xs text-error inline-flex items-center gap-1">
        <CircleAlert size={12} /> Save failed
      </span>
    );
  }
  return null;
}
