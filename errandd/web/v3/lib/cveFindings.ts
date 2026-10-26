import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import type { TreeSection } from "./tree";
/** SQL findings are subjects, not fabricated agent turns. Preserve real assessment threads. */
export function mergeCveFindings(section: TreeSection, findings: CveFindingSummary[]): TreeSection {
  const items = section.items.map((item) => ({ ...item }));
  for (const finding of findings) {
    const item = items.find(
      (item) =>
        (item.finding?.repository === finding.repository &&
          item.finding.aliases.some((alias) => finding.aliases.includes(alias))) ||
        (!item.finding &&
          item.repo === finding.repository &&
          finding.aliases.includes(item.name ?? "")),
    );
    if (item) {
      if (
        !item.finding ||
        (item.finding.status !== "affected" && finding.status === "affected") ||
        (item.finding.status === finding.status && finding.updatedAt >= item.finding.updatedAt)
      )
        item.finding = finding;
      item.lastAt = Math.max(item.lastAt, finding.updatedAt);
    }
  }
  const severity = ["critical", "high", "medium", "low", "unknown"];
  items.sort(
    (a, b) =>
      severity.indexOf(a.finding?.severity ?? "unknown") -
        severity.indexOf(b.finding?.severity ?? "unknown") || b.lastAt - a.lastAt,
  );
  return { ...section, items };
}
