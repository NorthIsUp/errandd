import { CveStatus } from "./CveStatus";
import { isCveId } from "../../../shared/cve";
import { cveReportProvenance } from "../lib/cveReportProvenance";
import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import { CveTechnologyIcons } from "./CveTechnologyIcons";
import { SidebarSubjectContent } from "./SidebarSubjectContent";


export function cveItemPresentation(finding: CveFindingSummary) {
  const packages = [...new Set((finding.packageNames.length ? finding.packageNames : finding.packages?.map(pkg => pkg.name) ?? []).map(name => name.trim()).filter(Boolean))];
  const cve = [finding.id, ...finding.aliases].map(id => id.toUpperCase()).filter(isCveId).sort()[0];
  const id = isCveId(finding.id.toUpperCase()) ? finding.id.toUpperCase() : cve ?? finding.id;
  const headline = packages.length ? `${packages.join(", ")} • ${id}` : id;
  const repository = finding.repository.split("/").pop() || finding.repository;
  const subtitle = packages.length ? repository : [repository, finding.title].filter(Boolean).join(" · ");
  const tooltip = [finding.title, id !== finding.id ? `Original report ID: ${finding.id}` : "", cveReportProvenance(finding)].filter(Boolean).join("\n\n");
  return { headline, subtitle, tooltip, label: `${headline}: ${finding.status} · ${finding.repository}` };
}

export function CveItemContent({ finding }: { finding: CveFindingSummary }) {
  const { headline, subtitle, tooltip } = cveItemPresentation(finding);
  return <SidebarSubjectContent icon={<CveTechnologyIcons finding={finding} />}
    title={headline} subtitle={subtitle} titleTooltip={tooltip} titleClassName="font-mono"
    trailing={<CveStatus finding={finding} />} />;
}
