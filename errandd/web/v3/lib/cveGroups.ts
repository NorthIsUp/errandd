import type { AffectedVersionRow } from "../../../shared/cveAffectedVersions";
import type { TreeItem } from "./tree";

export interface CveItemGroup {
  key: string;
  lastAt: number;
  items: [TreeItem, ...TreeItem[]];
  version: AffectedVersionRow | null;
}

/** Group only proven shared fixes; unknown or conflicting ranges stay independent. */
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
    const key =
      finding && pkg && version
        ? `cve-group:${JSON.stringify([finding.repository.toLowerCase(), finding.status, pkg.ecosystem.toLowerCase(), version.product, version.range.replace(/\s/g, ""), version.fixed])}`
        : item.key;
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      group.lastAt = Math.max(group.lastAt, item.lastAt);
    } else
      groups.set(key, { key, lastAt: item.lastAt, items: [item], version });
  }
  return [...groups.values()];
}
