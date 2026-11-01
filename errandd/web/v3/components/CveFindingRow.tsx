import { isCveId } from "../../../shared/cve";
import { cveReportProvenance } from "../lib/cveReportProvenance";
import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import { CveTechnologyIcons } from "./CveTechnologyIcons";
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
  const packages = [...new Set((finding.packageNames.length ? finding.packageNames : finding.packages?.map(pkg => pkg.name) ?? []).map(name => name.trim()).filter(Boolean))];
  const cve = [finding.id, ...finding.aliases].map(id => id.toUpperCase()).filter(isCveId).sort()[0];
  const id = isCveId(finding.id.toUpperCase()) ? finding.id.toUpperCase() : cve ?? finding.id;
  const headline = packages.length ? `${packages.join(", ")} • ${id}` : id;
  const repository = finding.repository.split("/").pop() || finding.repository;
  const subtitle = packages.length ? repository : [repository, finding.title].filter(Boolean).join(" · ");
  const tooltip = [finding.title, id !== finding.id ? `Original report ID: ${finding.id}` : "", cveReportProvenance(finding)].filter(Boolean).join("\n\n");
  return (
    <button
      type="button"
      aria-label={`${headline}: ${finding.status} · ${finding.repository}`}
      title={tooltip || undefined}
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
        >
          {headline}
        </span>
        {subtitle && <span className="block truncate text-[10px] text-base-content/50">{subtitle}</span>}
      </span>
      <span className="text-[9px] text-base-content/50" title={finding.applicability?.reason}>
        {finding.status === "resolved" ? "fixed" : finding.status === "not_affected" ? "not affected" : finding.severity}
      </span>
    </button>
  );
}
