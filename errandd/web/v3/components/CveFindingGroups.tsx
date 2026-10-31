import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { CveItemGroup } from "../lib/cveGroups";
import type { TreeItem } from "../lib/tree";
import { CveTechnologyIcons } from "./CveTechnologyIcons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

export function CveFindingGroups({
  groups,
  openMap,
  onToggleNode,
  renderItem,
}: {
  groups: CveItemGroup[];
  openMap: Record<string, boolean>;
  onToggleNode: (key: string) => void;
  renderItem: (item: TreeItem) => ReactNode;
}) {
  return groups.map((group) => {
    const finding = group.items[0].finding;
    if (!group.version || group.items.length === 1 || !finding)
      return group.items.map(renderItem);
    const open = openMap[group.key] === true;
    return (
      <Collapsible key={group.key} open={open}>
        <CollapsibleTrigger
          onClick={() => onToggleNode(group.key)}
          className="group flex w-full items-start gap-2 py-2 pl-5 pr-3 text-left hover:bg-base-200/60"
        >
          <ChevronRight
            size={12}
            className="mt-1 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          />
          <CveTechnologyIcons finding={finding} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">
              {group.version.product} · {group.items.length} CVEs
            </span>
            <span
              className="block truncate text-[10px] text-base-content/50"
              title={`Affected ${group.version.range}; fixed in ${group.version.fixed}`}
            >
              {finding.repository.split("/").pop()} · {group.version.range} ·
              fixed {group.version.fixed}
            </span>
          </span>
          <span className="text-[9px] text-base-content/50">
            {finding.status === "resolved" ? "fixed" : finding.severity}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="ml-4 border-l border-base-300/60">
          {group.items.map(renderItem)}
        </CollapsibleContent>
      </Collapsible>
    );
  });
}
