import { ChevronRight, Webhook } from "lucide-react";
import { Markdown } from "../prompt-kit/markdown";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

/**
 * A `system` part — a hook trigger or the agent's terminal status line
 * ("[skip]/[ok] …"). A long trigger renders as a collapsible card (collapsed by
 * default, showing a one-line summary) so it never dominates the thread as a
 * raw wall; a short notice renders as a compact banner. Both show a timestamp.
 */

function fmtTime(at?: number): string | null {
  if (!at) {
    return null;
  }
  try {
    return new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

export function SystemPart({ text, at }: { text: string; at?: number }) {
  const time = fmtTime(at);
  const long = text.length > 180;
  const firstLine = (text.split("\n").find((l) => l.trim()) ?? text)
    .replace(/\s*\(delivery [^)]+\):?/, "")
    .trim();

  if (!long) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-base-300 bg-base-200/40 px-3 py-2 text-xs text-base-content/70">
        <Webhook className="size-3.5 shrink-0 text-secondary" />
        <span className="flex-1 break-words">{text}</span>
        {time && (
          <time className="shrink-0 font-mono text-[10px] text-base-content/40">{time}</time>
        )}
      </div>
    );
  }

  return (
    <Collapsible className="overflow-hidden rounded-lg border border-base-300 bg-base-200/40">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-base-content/70 transition-colors hover:text-base-content">
        <Webhook className="size-3.5 shrink-0 text-secondary" />
        <span className="min-w-0 flex-1 truncate font-medium">{firstLine}</span>
        {time && (
          <time className="shrink-0 font-mono text-[10px] text-base-content/40">{time}</time>
        )}
        <ChevronRight className="size-3.5 shrink-0 text-base-content/40 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-base-300 px-3 py-2">
          <Markdown className="prose prose-sm max-w-none text-sm dark:prose-invert">
            {text}
          </Markdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
