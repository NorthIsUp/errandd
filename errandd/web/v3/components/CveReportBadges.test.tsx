import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CveTechnologyIcons } from "./CveTechnologyIcons";
import { CveFindingRow } from "./CveFindingRow";
import { CveReportBadges } from "./CveReportBadges";
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
test("source labels retain original publisher and technology icons have accessible names", () => {
  const html = renderToStaticMarkup(
    <CveFindingRow
      active={false}
      onSelect={() => {}}
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
  for (const label of ["Python", "JavaScript", "Web server"])
    expect(html).toContain(`aria-label="Affected technology: ${label}"`);
  expect(html.match(/aria-label="Affected technology: Python"/g)).toHaveLength(
    1,
  );
  expect(html.match(/Report source: pip-audit/g)).toHaveLength(1);
});
test("old findings omit unknown source and technology metadata", () => {
  expect(renderToStaticMarkup(<CveReportBadges finding={finding} />)).toBe("");
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
    <CveFindingRow finding={subject} active={false} onSelect={() => {}} />,
  );
  expect(html.indexOf('aria-label="Affected technology: Python"')).toBeLessThan(
    html.indexOf('title="test"'),
  );
  expect(html).not.toContain("lucide-file-code");
  expect(renderToStaticMarkup(<CveReportBadges finding={subject} />)).toBe("");
});
