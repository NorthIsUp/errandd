import { isCveNotAffected } from "../../../shared/cveSubscriptions";
import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import { cn } from "./ui/utils";

export function CveStatus({ finding, label }: { finding: CveFindingSummary; label?: string }) {
  const completed = finding.status === "resolved" || isCveNotAffected(finding);
  const tone = completed ? "text-success" : finding.severity === "critical" ? "text-error" : finding.severity === "high" ? "text-warning" : finding.severity === "medium" ? "text-info" : "text-base-content/50";
  const text = label ?? (isCveNotAffected(finding) ? "not affected" : completed ? "fixed" : finding.severity);
  return <span className={cn("text-[9px]", tone)} title={finding.applicability?.reason}>{text}</span>;
}
