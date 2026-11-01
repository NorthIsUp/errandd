import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import type { TreeItem, TreeSection } from "./tree";
/** SQL findings are subjects, not fabricated agent turns. Preserve real assessment threads. */
export function mergeCveFindings(section: TreeSection, findings: CveFindingSummary[]): TreeSection {
  const subjects = new Map<string, TreeItem>();
  const unmatched: TreeItem[] = [];
  const normalize = (value: string) => value.toLowerCase();
  for (const original of section.items) {
    const repository = normalize(original.finding?.repository ?? original.repo ?? "");
    const aliases = new Set([original.name ?? "", ...(original.finding?.aliases ?? [])].map(normalize));
    const related = findings.filter(finding => normalize(finding.repository) === repository && (
      (finding.remediationScope === original.key && original.routines.some(ref => ref.jobName === finding.job)) ||
      finding.aliases.some(alias => aliases.has(normalize(alias)))
    ));
    if (!related.length) { unmatched.push({ ...original }); continue; }
    for (const finding of related) {
      const key = JSON.stringify([normalize(finding.repository), finding.id]);
      const existing = subjects.get(key);
      if (!existing) {
        subjects.set(key, { ...original, key: finding.key, name: finding.id,
          title: `${finding.id} — ${finding.title}`, finding, routines: original.routines,
          lastAt: Math.max(original.lastAt, finding.updatedAt) });
        continue;
      }
      const refs = new Map(existing.routines.map(ref => [ref.threadId, ref]));
      for (const ref of original.routines) {
        const previous = refs.get(ref.threadId);
        if (!previous || ref.lastAt > previous.lastAt) refs.set(ref.threadId, ref);
      }
      existing.routines = [...refs.values()];
      if ((existing.finding?.status !== "affected" && finding.status === "affected") ||
          (existing.finding?.status === finding.status && finding.updatedAt > existing.finding.updatedAt)) existing.finding = finding;
      existing.lastAt = Math.max(existing.lastAt, original.lastAt, finding.updatedAt);
    }
  }
  const items = [...subjects.values(), ...unmatched];
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
