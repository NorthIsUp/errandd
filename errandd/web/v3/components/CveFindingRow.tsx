import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import { CveTechnologyIcons } from "./CveTechnologyIcons";
import { CveReportBadges } from "./CveReportBadges";
import { cn } from "./ui/utils";

export function CveFindingRow({
  finding,
  active,
  onSelect,
}: {
  finding: CveFindingSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${finding.id}: ${finding.status} · ${finding.repository}`}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-2 pl-8 text-left hover:bg-base-200/60",
        active && "bg-base-200",
      )}
    >
      <CveTechnologyIcons finding={finding} />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate font-mono text-xs font-medium"
          title={finding.title}
        >
          {finding.id}
        </span>
        <span className="block truncate text-[10px] text-base-content/50">
          {finding.repository.split("/").pop()} ·{" "}
          {finding.packageNames.join(", ") || finding.title}
        </span>
        <CveReportBadges finding={finding} />
      </span>
      <span className="text-[9px] text-base-content/50" title={finding.applicability?.reason}>
        {finding.status === "resolved" ? "fixed" : finding.status === "not_affected" ? "not affected" : finding.severity}
      </span>
    </button>
  );
}
