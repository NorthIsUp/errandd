const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
export interface AffectedVersionRow { product: string; range: string; fixed: string }

/** Present upstream ranges verbatim or as equivalent bounds; never infer a fix. */
export function affectedVersionRows(affected: unknown[]): AffectedVersionRow[] {
  const rows: AffectedVersionRow[] = [];
  for (const value of affected) {
    const item = object(value), pkg = object(item.package);
    const product = text(pkg.name) || text(item.packageName) || text(item.product) || "Unspecified product";
    if (typeof item.vulnerable_version_range === "string") {
      rows.push({ product, range: item.vulnerable_version_range, fixed: text(item.first_patched_version) || text(object(item.first_patched_version).identifier) || "Not specified" });
      continue;
    }
    for (const raw of list(item.ranges)) {
      const range = object(raw);
      let start: string | undefined;
      for (const entry of list(range.events)) {
        const event = object(entry);
        if (typeof event.introduced === "string") start = event.introduced;
        const end = text(event.fixed) || text(event.last_affected) || text(event.limit);
        if (end || typeof event.introduced === "string") {
          // Introduced events start an interval; emit when it ends, or if open-ended.
          if (!end) continue;
          const bounds = [start && start !== "0" ? `>= ${start}` : "", `${event.last_affected ? "<=" : "<"} ${end}`].filter(Boolean).join(", ");
          rows.push({ product, range: range.type === "GIT" ? `Git commits from ${start === "0" ? "the beginning" : start ?? "unspecified"} through ${end} (${event.last_affected ? "inclusive" : "exclusive"})` : bounds, fixed: text(event.fixed) || "Not specified" });
          start = undefined;
        }
      }
      if (start) rows.push({ product, range: range.type === "GIT" ? `Git commits from ${start}` : start === "0" ? "All versions (no upper bound provided)" : `>= ${start} (no upper bound provided)`, fixed: "Not specified" });
    }
    const versions = list(item.versions);
    if (versions.every(version => typeof version === "string") && versions.length) rows.push({ product, range: versions.join(", "), fixed: "Not specified" });
    else for (const raw of versions) {
      const version = object(raw);
      const bounds = [text(version.version), version.lessThan ? `< ${text(version.lessThan)}` : version.lessThanOrEqual ? `<= ${text(version.lessThanOrEqual)}` : ""].filter(Boolean).join(", ");
      const changes = list(version.changes).map(raw => { const change = object(raw); return `${text(change.at)}: ${text(change.status)}`; }).join("; ");
      rows.push({ product, range: `${bounds || "Unspecified range"} (${text(version.status) || "status unspecified"})${changes ? `; status changes: ${changes}` : ""}`, fixed: "Not specified" });
    }
    if (typeof item.defaultStatus === "string") rows.push({ product, range: `Other versions: ${item.defaultStatus}`, fixed: "Not specified" });
  }
  return [...new Map(rows.map(row => [JSON.stringify(row), row])).values()];
}
