import { ecosystemLanguages, ecosystemName, type CveAlert } from "./cve";

interface PackageAdvisoryInput
  extends Pick<
    CveAlert,
    | "source"
    | "id"
    | "aliases"
    | "title"
    | "description"
    | "updatedAt"
    | "url"
    | "affected"
    | "references"
  > {
  packages: { name: string; ecosystem: string }[];
  severity: string;
  rejected: boolean;
  score?: number | null;
  weaknesses?: CveAlert["weaknesses"];
}

export function packageAdvisory(input: PackageAdvisoryInput): CveAlert {
  const { packages, severity, ...advisory } = input;
  const ecosystems = [
    ...new Set(packages.map((pkg) => ecosystemName(pkg.ecosystem)).filter(Boolean)),
  ];
  const products = packages
    .filter((pkg) => pkg.name)
    .map((pkg) => ({ vendor: "", product: pkg.name }));
  return {
    ...advisory,
    schema: "errandd.cve.v1",
    title: input.title.slice(0, 500),
    description: input.description.slice(0, 16000),
    severity: ["low", "medium", "high", "critical"].includes(severity.toLowerCase())
      ? severity.toLowerCase()
      : "unknown",
    score: input.score ?? null,
    project: "",
    products,
    ecosystems,
    languages: [...new Set(ecosystems.flatMap(ecosystemLanguages))],
    technologies: [...new Set([...products.map((product) => product.product), ...ecosystems])],
    test: false,
  };
}

type Report = NonNullable<CveAlert["sources"]>[number];
type ReportedAdvisory = Pick<CveAlert, "sources"> &
  Partial<Pick<CveAlert, "source" | "url" | "updatedAt">>;

/** Source and URL identify a report; later timestamps enrich that report rather than duplicate it. */
export function mergeReportSources(...advisories: ReportedAdvisory[]): Report[] {
  const reports = new Map<string, Report>();
  for (const advisory of advisories) {
    const incoming = [...(advisory.sources ?? [])];
    if (advisory.source && advisory.url)
      incoming.push({
        source: advisory.source,
        url: advisory.url,
        updatedAt: advisory.updatedAt ?? "",
      });
    for (const report of incoming) {
      const key = JSON.stringify([report.source, report.url]);
      const previous = reports.get(key);
      if (!previous || !(Date.parse(previous.updatedAt) > Date.parse(report.updatedAt)))
        reports.set(key, report);
    }
  }
  return [...reports.values()]
    .sort((a, b) => a.source.localeCompare(b.source) || a.url.localeCompare(b.url))
    .slice(0, 80);
}
