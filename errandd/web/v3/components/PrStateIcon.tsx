import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  TriangleAlert,
} from "lucide-react";
import type { ComponentType } from "react";
import type { PrGitState } from "../../../shared/prState";
import { cn } from "./ui/utils";

/**
 * Per-PR git-state icon (open / draft / merged / closed / conflicted). Colors
 * use daisyUI tokens where they map cleanly (success/error/warning); merged
 * uses GitHub's merge-purple since no daisy token is purple, and draft its
 * neutral grey. `unknown` is the fail-safe fallback — a faint pull-request
 * outline — so an unclassified state renders quietly instead of crashing the row.
 */
export const PR_STATE_META: Record<
  PrGitState,
  { Icon: ComponentType<{ className?: string }>; className: string; label: string }
> = {
  open: { Icon: GitPullRequest, className: "text-success", label: "Open" },
  draft: { Icon: GitPullRequestDraft, className: "text-base-content/50", label: "Draft" },
  merged: { Icon: GitMerge, className: "text-violet-500", label: "Merged" },
  closed: { Icon: GitPullRequestClosed, className: "text-error", label: "Closed" },
  conflicted: { Icon: TriangleAlert, className: "text-warning", label: "Merge conflict" },
  unknown: { Icon: GitPullRequest, className: "text-base-content/35", label: "Unknown state" },
};

export function PrStateIcon({ state }: { state: PrGitState | undefined }) {
  const meta = PR_STATE_META[state ?? "unknown"];
  const Icon = meta.Icon;
  return (
    <span
      title={`PR state: ${meta.label}`}
      aria-label={`PR state: ${meta.label}`}
      className="flex shrink-0 items-center"
    >
      <Icon className={cn("size-3.5", meta.className)} />
    </span>
  );
}
