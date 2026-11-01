import type { CveFindingSummary } from "../../../shared/cveSubscriptions";

const SOURCE_LABELS: Record<string, string> = {
  "cve.org": "CVE.org", cvefeed: "CVEFeed", github: "GitHub", osv: "OSV",
  nvd: "NVD", pypi: "pip-audit", npm: "npm audit", Tailscale: "Tailscale", "Google Cloud": "Google Cloud",
};

export function cveReportProvenance(finding: CveFindingSummary): string {
  const reports = new Map<string, Set<string>>();
  for (const report of finding.sources ?? []) {
    const label = SOURCE_LABELS[report.source] ?? report.source;
    const urls = reports.get(label) ?? new Set<string>();
    if (report.url) urls.add(report.url);
    reports.set(label, urls);
  }
  return [...reports].map(([label, urls]) => [`Report source: ${label}`, ...urls].join("\n")).join("\n\n");
}
