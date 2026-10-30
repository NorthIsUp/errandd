import {
  Boxes,
  Braces,
  Code,
  Coffee,
  Database,
  FileCode,
  Globe,
  Hexagon,
  Package,
  Server,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
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
const TECHNOLOGIES: { label: string; Icon: LucideIcon; names: string[] }[] = [
  { label: "Python", Icon: FileCode, names: ["python", "pypi", "pip"] },
  {
    label: "JavaScript",
    Icon: Braces,
    names: ["javascript", "typescript", "npm", "node", "node.js", "bun"],
  },
  { label: "Rust", Icon: Hexagon, names: ["rust", "crates.io", "cargo"] },
  { label: "Go", Icon: Code, names: ["go", "golang"] },
  { label: "Java", Icon: Coffee, names: ["java", "maven", "gradle"] },
  { label: "Containers", Icon: Boxes, names: ["docker", "container", "kubernetes", "gke"] },
  {
    label: "Database",
    Icon: Database,
    names: ["postgresql", "postgres", "mysql", "redis", "sqlite"],
  },
  { label: "Web server", Icon: Server, names: ["nginx", "apache", "httpd"] },
];

export function CveReportBadges({ finding }: { finding: CveFindingSummary }) {
  const sources = [...new Set((finding.sources ?? []).map((report) => report.source))];
  const technologies = new Set((finding.technologies ?? []).map((value) => value.toLowerCase()));
  const icons = TECHNOLOGIES.filter((technology) =>
    technology.names.some((name) => technologies.has(name)),
  );
  const unknown = icons.length === 0 && technologies.size > 0;
  if (!sources.length && !icons.length && !unknown) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1 text-[9px] text-base-content/60">
      {sources.map((source) => {
        const { label, Icon } = SOURCE_META[source] ?? { label: source, Icon: ShieldCheck };
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
      {icons.map(({ label, Icon }) => (
        <span
          key={label}
          role="img"
          aria-label={`Affected technology: ${label}`}
          title={`Affected technology: ${label}`}
          className="inline-flex p-0.5"
        >
          <Icon size={12} aria-hidden="true" />
        </span>
      ))}
      {unknown && (
        <span
          role="img"
          aria-label={`Affected technologies: ${[...technologies].join(", ")}`}
          title={`Affected technologies: ${[...technologies].join(", ")}`}
        >
          <Package size={12} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
