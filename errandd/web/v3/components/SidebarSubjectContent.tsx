import type { ReactNode } from "react";
import { cn } from "./ui/utils";

/** Presenters supply domain facts; the subject disclosure owns interaction. */
export function SidebarSubjectContent({ icon, title, subtitle, trailing, titleTooltip, subtitleTooltip, titleClassName }: {
  icon?: ReactNode; title: string; subtitle?: ReactNode; trailing?: ReactNode;
  titleTooltip?: string; subtitleTooltip?: string; titleClassName?: string;
}) {
  return <>
    {icon}
    <span className="min-w-0 flex-1">
      <span className={cn("block truncate text-xs font-medium", titleClassName)} title={titleTooltip}>{title}</span>
      {subtitle && <span className="block truncate text-[10px] text-base-content/50" title={subtitleTooltip}>{subtitle}</span>}
    </span>
    {trailing}
  </>;
}
