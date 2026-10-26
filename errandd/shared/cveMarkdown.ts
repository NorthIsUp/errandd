import { affectedVersionRows } from "./cveAffectedVersions";
import { isCveId, isGhsaId, type CveAlert } from "./cve";
import type { LockedPackage } from "./cveSubscriptions";

const cell = (value: string) => value.replace(/[\\`*_[\]<>]/g, "\\$&").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** One Markdown source message for both live CVE hooks and cached match previews. */
export function cveAlertMarkdown(alert: Pick<CveAlert, "id" | "title" | "severity" | "url"> & {
  aliases?: string[]; targetRepository?: string; description?: string;
  dependencyEvidence?: LockedPackage[]; references?: string[]; affected?: unknown[]; weaknesses?: CveAlert["weaknesses"];
}): string {
  const cveIds = [...new Set([alert.id, ...(alert.aliases ?? [])].map(id => id.toUpperCase()).filter(isCveId))];
  const ghsaIds = [...new Set([alert.id, ...(alert.aliases ?? [])].filter(isGhsaId))];
  const recordLinks = cveIds.flatMap(id => [
    `[CVE.org${cveIds.length > 1 ? ` · ${id}` : ""}](https://www.cve.org/CVERecord?id=${id})`,
    `[NIST NVD${cveIds.length > 1 ? ` · ${id}` : ""}](https://nvd.nist.gov/vuln/detail/${id})`,
    ...(!ghsaIds.length ? [`[GitHub search](https://github.com/advisories?query=${encodeURIComponent(id)})`] : []),
  ]);
  recordLinks.push(...ghsaIds.map(id => `[GitHub${ghsaIds.length > 1 ? ` · ${id}` : ""}](https://github.com/advisories/${id})`));
  const original = recordLinks.length ? `**Advisory records:** ${recordLinks.join(" · ")}`
    : /^https?:\/\//i.test(alert.url) ? `**Original advisory:** <${alert.url.replace(/[<>\s]/g, encodeURIComponent)}>` : "";
  const lines = [
    `## ${cell(alert.id)} — ${cell(alert.title)}`,
    original,
    `**Severity:** ${cell(alert.severity)}`,
    `**Aliases:** ${(alert.aliases ?? [alert.id]).map(cell).join(", ")}`,
    alert.description ?? "",
  ];
  const versions = affectedVersionRows(alert.affected ?? []);
  lines.push("### Affected versions", versions.length
    ? "| Package / product | Affected range | Fixed in |\n| --- | --- | --- |\n" + versions.map(row => `| ${[row.product, row.range, row.fixed].map(cell).join(" | ")} |`).join("\n")
    : "The source advisory does not specify structured affected-version ranges. Consult the linked records; a locked-version match alone does not establish exploitability.");
  const weaknesses = (alert.weaknesses ?? []).filter(weakness => /^CWE-[1-9]\d*$/.test(weakness.id));
  lines.push("### Common Weakness Enumeration (CWE)", weaknesses.length
    ? weaknesses.map(weakness => `- [${weakness.id}](https://cwe.mitre.org/data/definitions/${weakness.id.slice(4)}.html)${weakness.name ? ` — ${cell(weakness.name)}` : ""}`).join("\n")
    : "No CWE classification supplied by the source advisory.");
  lines.push("### Advisory evidence", [...new Set([alert.url, ...(alert.references ?? [])])].filter(url => /^https?:\/\//i.test(url)).map(url => `- <${url.replace(/[<>\s]/g, encodeURIComponent)}>`).join("\n"));
  return lines.filter(Boolean).join("\n\n");
}
