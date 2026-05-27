import { GitPullRequest, Square } from "lucide-react";
import type { Ref } from "../refs";

/**
 * Renders a horizontal bar of clickable reference pills (PRs, Linear, etc.).
 * Each pill opens its href in a new tab. Empty list → renders nothing.
 */
export function Pills({ refs }: { refs: Ref[] }) {
  if (refs.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {refs.map((r) => (
        <a
          key={r.key}
          href={r.href}
          target="_blank"
          rel="noopener noreferrer"
          className={`badge gap-1 ${pillClass(r.kind)} hover:opacity-80`}
          title={r.href}
        >
          <PillIcon kind={r.kind} />
          <span className="font-mono text-xs">{r.label}</span>
        </a>
      ))}
    </div>
  );
}

function pillClass(kind: Ref["kind"]): string {
  if (kind === "pr") {
    return "badge-success";
  }
  if (kind === "linear") {
    return "badge-info";
  }
  return "badge-ghost";
}

function PillIcon({ kind }: { kind: Ref["kind"] }) {
  if (kind === "pr") {
    return <GitPullRequest size={12} aria-hidden />;
  }
  return <Square size={12} aria-hidden />;
}
