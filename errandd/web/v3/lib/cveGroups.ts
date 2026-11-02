import type { AffectedVersionRow } from "../../../shared/cveAffectedVersions";
import { remediationIdentity } from "../../../shared/cveRemediation";
import type { TreeItem } from "./tree";

export interface CveItemGroup {
  key: string;
  lastAt: number;
  items: [TreeItem, ...TreeItem[]];
  version: AffectedVersionRow | null;
  packageName: string | null;
  sharedChat?: TreeItem;
}

/** Group remediation work by package; preserve each advisory and its own fix evidence. */
export function groupCveItems(items: TreeItem[]): CveItemGroup[] {
  const groups = new Map<string, CveItemGroup>();
  for (const item of items) {
    const finding = item.finding;
    const packages = new Map(
      (finding?.packages ?? []).map((pkg) => [
        JSON.stringify([pkg.ecosystem, pkg.name]),
        pkg,
      ]),
    );
    const pkg =
      packages.size === 1 ? packages.values().next().value : undefined;
    const versions = new Map(
      (finding?.affectedVersions ?? [])
        .filter(
          (row) =>
            row.product === pkg?.name && row.fixed !== "Not specified",
        )
        .map((row) => [
          JSON.stringify([
            row.product,
            row.range.replace(/\s/g, ""),
            row.fixed,
          ]),
          row,
        ]),
    );
    const version =
      versions.size === 1 ? (versions.values().next().value ?? null) : null;
    const identity = finding ? remediationIdentity(finding.repository, [...packages.values()]) : null;
    const key = identity && finding
      ? `cve-group:${JSON.stringify([finding.status, identity])}` : item.key;
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      if (!version || version.product !== group.version?.product ||
        version.range.replace(/\s/g, "") !== group.version.range.replace(/\s/g, "") ||
        version.fixed !== group.version.fixed) group.version = null;
      group.lastAt = Math.max(group.lastAt, item.lastAt);
    } else
      groups.set(key, { key, lastAt: item.lastAt, items: [item], version, packageName: [...new Set([...packages.values()].map(value => value.name))].sort().join(", ") || null });
  }
  return [...groups.values()].map(group => {
    const refs = new Map<string, TreeItem["routines"][number]>();
    const withoutSharedChat = (item: TreeItem): TreeItem => {
      const scope = item.finding?.remediationScope;
      const routines = item.routines.filter(ref => {
        if (!scope || ref.threadId !== `${ref.jobName}:hook:${scope}`) return true;
        refs.set(ref.threadId, ref);
        return false;
      });
      return routines.length === item.routines.length ? item : { ...item, routines };
    };
    group.items = [withoutSharedChat(group.items[0]), ...group.items.slice(1).map(withoutSharedChat)];
    if (refs.size) group.sharedChat = { key: `${group.key}:chat`, title: `${group.packageName} remediation chat`,
      routines: [...refs.values()], lastAt: Math.max(...[...refs.values()].map(ref => ref.lastAt)) };
    return group;
  });
}
