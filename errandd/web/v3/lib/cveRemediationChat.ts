import type { TreeItem } from "./tree";

/** A package chat has no single-advisory verdict or title. */
export function cveRemediationChat(item: TreeItem): TreeItem | null {
  const finding = item.finding;
  const names = finding?.packageNames.length ? finding.packageNames : finding?.packages?.map(pkg => pkg.name) ?? [];
  if (!finding?.remediationScope || !names.length) return null;
  const routines = item.routines.filter(ref => ref.threadId === `${ref.jobName}:hook:${finding.remediationScope}`);
  if (!routines.length) return null;
  return { key: finding.remediationScope, title: `${[...new Set(names)].sort().join(", ")} remediation chat`,
    repo: finding.repository, routines, lastAt: Math.max(...routines.map(ref => ref.lastAt)) };
}
