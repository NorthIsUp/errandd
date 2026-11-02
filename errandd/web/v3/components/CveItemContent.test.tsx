import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CveTechnologyIcons } from "./CveTechnologyIcons";
import { CveItemContent } from "./CveItemContent";
import { cveReportProvenance } from "../lib/cveReportProvenance";
import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
const finding: CveFindingSummary = {
  key: "test",
  id: "CVE-2026-12345",
  aliases: [],
  job: "security",
  repository: "example/backend",
  title: "test",
  severity: "high",
  status: "affected",
  updatedAt: 1,
  packageNames: ["django"],
};
test("provenance remains accessible without a visible source badge row", () => {
  const html = renderToStaticMarkup(
    <CveItemContent
      finding={{
        ...finding,
        sources: [
          "pypi",
          "npm",
          "Tailscale",
          "Google Cloud",
          "osv",
          "pypi",
        ].map((source) => ({
          source,
          url: "https://example.com/report",
          updatedAt: "2026-10-28",
        })),
        technologies: ["PyPI", "python", "npm", "typescript", "nginx"],
      }}
    />,
  );
  for (const label of [
    "pip-audit",
    "npm audit",
    "Tailscale",
    "Google Cloud",
    "OSV",
  ])
    expect(html).toContain(`Report source: ${label}`);
  for (const label of ["Python", "npm", "Web server"])
    expect(html).toContain(`aria-label="Affected technology: ${label}"`);
  expect(html.match(/aria-label="Affected technology: Python"/g)).toHaveLength(
    1,
  );
  expect(html).toContain('title="test');
  const visibleText = html.replace(/<[^>]*>/g, "");
  for (const label of ["pip-audit", "npm audit", "OSV", "Tailscale"]) expect(visibleText).not.toContain(label);
  expect(visibleText).toContain("django • CVE-2026-12345");
  expect(html).toContain(">backend</span>");
  expect(visibleText.match(/django/g)).toHaveLength(1);
});
test("old findings omit unknown source and technology metadata", () => {
  expect(cveReportProvenance(finding)).toBe("");
  expect(
    renderToStaticMarkup(
      <CveTechnologyIcons
        finding={{ ...finding, technologies: ["unknown-tool"] }}
      />,
    ),
  ).toContain("Affected technologies: unknown-tool");
});

test("Python branding precedes the CVE title and never adds a technology-only footer", () => {
  const subject = { ...finding, technologies: ["PyPI", "python"] };
  const html = renderToStaticMarkup(
    <CveItemContent finding={subject} />,
  );
  expect(html.indexOf('aria-label="Affected technology: Python"')).toBeLessThan(
    html.indexOf(">django • CVE-2026-12345</span>"),
  );
  expect(html).not.toContain("lucide-file-code");
  expect(html).not.toContain("rounded-full");
  expect(cveReportProvenance(subject)).toBe("");
});


test("undici uses the Node.js logo while other npm packages use npm, without braces or duplicate ecosystem icons", () => {
  const html = renderToStaticMarkup(<CveTechnologyIcons finding={{ ...finding, packageNames: ["undici"], technologies: ["npm", "javascript", "typescript"] }} />);
  expect(html).toContain('aria-label="Affected technology: Node.js"');
  expect(html).not.toContain('aria-label="Affected technology: npm"');
  expect(html).not.toContain("lucide-braces");
  const npm = renderToStaticMarkup(<CveTechnologyIcons finding={{ ...finding, packageNames: ["minimatch"], packages: [{ name: "minimatch", ecosystem: "npm" }] }} />);
  expect(npm).toContain('aria-label="Affected technology: npm"');
  expect(npm).not.toContain("lucide-braces");
});

test("an applicability decision is labeled not affected rather than fixed", () => {
  const html = renderToStaticMarkup(<CveItemContent finding={{ ...finding, status: "not_affected" }} />);
  expect(html).toContain("not affected");
  expect(html).not.toContain(">fixed<");
});


test("package-first headlines prefer a real CVE alias and preserve original GHSA provenance", () => {
  const html = renderToStaticMarkup(<CveItemContent finding={{ ...finding, id: "GHSA-2345-6789-cfgh", aliases: ["GHSA-2345-6789-cfgh", "CVE-2026-55555"], packageNames: ["undici"] }} />);
  expect(html).toContain(">undici • CVE-2026-55555</span>");
  expect(html).toContain("Original report ID: GHSA-2345-6789-cfgh");
  const ghsaOnly = renderToStaticMarkup(<CveItemContent finding={{ ...finding, id: "GHSA-2345-6789-cfgh", aliases: [] }} />);
  expect(ghsaOnly).toContain(">django • GHSA-2345-6789-cfgh</span>");
});

test("missing package metadata keeps an honest identifier and fallback context", () => {
  const html = renderToStaticMarkup(<CveItemContent finding={{ ...finding, packageNames: [] }} />);
  expect(html).toContain(">CVE-2026-12345</span>");
  expect(html).toContain(">backend · test</span>");
  expect(html.replace(/<[^>]*>/g, "")).not.toContain(" • ");
  const multiple = renderToStaticMarkup(<CveItemContent finding={{ ...finding, packageNames: ["undici", "glob", "undici"] }} />);
  expect(multiple).toContain(">undici, glob • CVE-2026-12345</span>");
});

test("source summaries deduplicate publisher URLs while preserving all original report links", () => {
  const provenance = cveReportProvenance({ ...finding, sources: [
    { source: "npm", url: "https://example.com/npm/1", updatedAt: "" },
    { source: "npm", url: "https://example.com/npm/1", updatedAt: "" },
    { source: "npm", url: "https://example.com/npm/2", updatedAt: "" },
    { source: "osv", url: "https://osv.dev/report", updatedAt: "" },
  ] });
  expect(provenance.match(/Report source: npm audit/g)).toHaveLength(1);
  expect(provenance.match(/https:\/\/example.com\/npm\/1/g)).toHaveLength(1);
  expect(provenance).toContain("https://example.com/npm/2");
  expect(provenance).toContain("Report source: OSV");
});

test("compact rows retain the not-affected decision reason tooltip", () => {
  const html = renderToStaticMarkup(<CveItemContent finding={{ ...finding, status: "resolved", applicability: { verdict: "not_affected", reason: "Only build tooling consumes this package; runtime paths do not.", assessedAt: 1, repositoryRevision: "a".repeat(40), context: "b".repeat(32), evidence: ["https://example.com/assessment"], coverage: { dependencies: "All installed dependency paths were checked.", sourceAndConfiguration: "Source and configuration paths were checked.", vendoredAndGenerated: "Vendored and generated sources were checked.", imagesAndArtifacts: "Built images and artifacts were checked.", deploymentAndRuntime: "Deployment and runtime configuration was checked." }, unscannedPathEvidence: {} } }} />);
  expect(html).toContain('title="Only build tooling consumes this package; runtime paths do not."');
  expect(html).toContain(">not affected</span>");
});
