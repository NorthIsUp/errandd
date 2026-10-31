import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import type { TreeItem, TreeSection } from "./tree";
/** SQL findings are subjects, not fabricated agent turns. Preserve real assessment threads. */
export function mergeCveFindings(section: TreeSection, findings: CveFindingSummary[]): TreeSection {
  // One package chat can carry many distinct advisories. Project each finding
  // onto that real thread rather than discarding all but the first CVE.
  const items = section.items.flatMap(item => {
    const related = findings.filter(finding => finding.remediationScope === item.key &&
      item.routines.some(ref => ref.jobName === finding.job));
    return related.length ? related.map(finding => ({ ...item, key: finding.key,
      name: finding.id, title: `${finding.id} — ${finding.title}`, finding })) : [{ ...item }];
  });
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

/** Keep references to the canonical PR entries so mirrored rows share live activity. */
export function cvePullRequests(item: TreeItem, pullRequests: TreeItem[]): TreeItem[] {
  const repository = item.finding?.repository ?? item.repo;
  const aliases = new Set(
    [item.finding?.id, ...(item.finding?.aliases ?? []), item.name]
      .filter((alias): alias is string => Boolean(alias))
      .map(alias => alias.toUpperCase()),
  );
  return pullRequests.filter(pr =>
    pr.num != null && pr.repo?.toLowerCase() === repository?.toLowerCase() &&
    (pr.title.match(/\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\b/gi) ?? [])
      .some(alias => aliases.has(alias.toUpperCase())),
  );
}
