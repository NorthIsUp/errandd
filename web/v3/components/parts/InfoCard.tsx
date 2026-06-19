import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Markdown } from "../prompt-kit/markdown";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../ui/utils";

/**
 * Shared shell for the two "out-of-band" notice parts — `SystemPart` (a hook
 * trigger / terminal status, base palette) and `InfoPart` (an FYI block that was
 * NOT in the model's context, blue `info` palette). A long body renders as a
 * collapsible card (collapsed, one-line summary); a short body renders as a
 * compact banner. Both show a timestamp. Only the palette + icon + optional
 * header label differ between the two callers — the collapse logic lives here
 * once.
 */

export function fmtTime(at?: number): string | null {
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

/** Tailwind/daisyUI palette tokens for an InfoCard variant. */
export interface InfoCardPalette {
  /** Card border + background, e.g. "border-base-300 bg-base-200/40". */
  shell: string;
  /** Idle text colour for the banner / trigger row. */
  text: string;
  /** Leading icon colour. */
  icon: string;
  /** Divider above the expanded body. */
  divider: string;
}

export const SYSTEM_PALETTE: InfoCardPalette = {
  shell: "border-base-300 bg-base-200/40",
  text: "text-base-content/70",
  icon: "text-secondary",
  divider: "border-base-300",
};

export const INFO_PALETTE: InfoCardPalette = {
  shell: "border-info/40 bg-info/10",
  text: "text-info-content/80",
  icon: "text-info",
  divider: "border-info/30",
};

export function InfoCard({
  text,
  at,
  icon,
  palette,
  /** Optional label shown before the summary on the trigger (e.g. FYI). */
  header,
  /** Char length above which the card becomes collapsible (default 180). */
  longThreshold = 180,
}: {
  text: string;
  at?: number;
  icon: ReactNode;
  palette: InfoCardPalette;
  header?: string;
  longThreshold?: number;
}) {
  const time = fmtTime(at);
  const long = text.length > longThreshold;
  const firstLine = (text.split("\n").find((l) => l.trim()) ?? text)
    .replace(/\s*\(delivery [^)]+\):?/, "")
    .trim();

  if (!long) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
          palette.shell,
          palette.text,
        )}
      >
        <span className={cn("shrink-0", palette.icon)}>{icon}</span>
        {header && (
          <span className={cn("shrink-0 font-medium uppercase tracking-wide opacity-70")}>
            {header}
          </span>
        )}
        <span className="flex-1 break-words">{text}</span>
        {time && (
          <time className="shrink-0 font-mono text-[10px] opacity-60">{time}</time>
        )}
      </div>
    );
  }

  return (
    <Collapsible className={cn("overflow-hidden rounded-lg border", palette.shell)}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-100",
          palette.text,
        )}
      >
        <span className={cn("shrink-0", palette.icon)}>{icon}</span>
        {header && (
          <span className="shrink-0 font-medium uppercase tracking-wide opacity-70">
            {header}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{firstLine}</span>
        {time && (
          <time className="shrink-0 font-mono text-[10px] opacity-60">{time}</time>
        )}
        <ChevronRight className="size-3.5 shrink-0 opacity-50 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn("border-t px-3 py-2", palette.divider)}>
          <Markdown className="prose prose-sm max-w-none text-sm dark:prose-invert">
            {text}
          </Markdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
