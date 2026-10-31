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
      <span
        className={cn(
          "mt-1 size-1.5 shrink-0 rounded-full",
          finding.status === "resolved" ? "bg-success" : "bg-warning",
        )}
      />
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
      <span className="text-[9px] text-base-content/50">
        {finding.status === "resolved" ? "fixed" : finding.severity}
      </span>
    </button>
  );
}
