import { Globe, Package, ShieldCheck, type LucideIcon } from "lucide-react";
import type { CveFindingSummary } from "../../../shared/cveSubscriptions";

const SOURCE_META: Record<string, { label: string; Icon: LucideIcon }> = {
  "cve.org": { label: "CVE.org", Icon: ShieldCheck },
  cvefeed: { label: "CVEFeed", Icon: ShieldCheck },
  github: { label: "GitHub", Icon: ShieldCheck },
  osv: { label: "OSV", Icon: ShieldCheck },
  nvd: { label: "NVD", Icon: ShieldCheck },
  pypi: { label: "pip-audit", Icon: Package },
  npm: { label: "npm audit", Icon: Package },
  Tailscale: { label: "Tailscale", Icon: Globe },
  "Google Cloud": { label: "Google Cloud", Icon: Globe },
};

export function CveReportBadges({ finding }: { finding: CveFindingSummary }) {
  const sources = [
    ...new Set((finding.sources ?? []).map((report) => report.source)),
  ];
  if (!sources.length) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1 text-[9px] text-base-content/60">
      {sources.map((source) => {
        const { label, Icon } = SOURCE_META[source] ?? {
          label: source,
          Icon: ShieldCheck,
        };
        const urls = finding.sources
          ?.filter((report) => report.source === source)
          .map((report) => report.url)
          .join("\n");
        return (
          <span
            key={source}
            className="inline-flex items-center gap-0.5 rounded border border-base-300 px-1 py-0.5"
            title={`Report source: ${label}${urls ? `\n${urls}` : ""}`}
          >
            <Icon size={10} aria-hidden="true" />
            {label}
          </span>
        );
      })}
    </span>
  );
}
