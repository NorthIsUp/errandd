import { expect, test } from "bun:test";
import { cveSystemContextMarkdown } from "../../shared/cveSystemContext";
import { cveAlertMarkdown } from "../../shared/cveMarkdown";
import { buildHookEssentials, renderHookEssentialsMarkdown } from "../../shared/hookEssentials";

test("CVE Markdown preserves lockfile evidence without breaking table cells", () => {
  const markdown = cveAlertMarkdown({ id: "CVE-2026-1234", title: "Unsafe <img>", severity: "high", url: "https://example.com/advisory", targetRepository: "example/repo", dependencyEvidence: [{ name: "name|injected", ecosystem: "npm", version: "1.0.0", path: "a\n|b" }], references: ["javascript:alert(1)"] });
  expect(markdown).toContain("## CVE-2026-1234");
  const context = cveSystemContextMarkdown({ dependencyEvidence: [{ name: "name|injected", ecosystem: "npm", version: "1.0.0", path: "a\n|b" }] });
  expect(context).toContain("name\\|injected");
  expect(context).toContain("a \\|b");
  expect(markdown).not.toContain("javascript:");
  expect(markdown).not.toContain("<img>");
});

test("live CVE notifications contain advisory facts without generated repository analysis", () => {
  const payload = { schema: "errandd.cve.v1", id: "CVE-2026-1234", title: "Test advisory", severity: "high", score: null, source: "osv", url: "https://example.com/advisory", publishedAt: null, updatedAt: null, description: "Evidence", products: [], ecosystems: [], languages: [], technologies: [], affected: [], references: [], rejected: false, test: false, targetRepository: "example/repo", dependencyEvidence: [{ name: "package", ecosystem: "npm", version: "1.0.0", path: "package-lock.json" }] };
  const markdown = renderHookEssentialsMarkdown(buildHookEssentials("cve:alert", payload));
  expect(markdown).toStartWith("## CVE-2026-1234");
  expect(markdown).not.toContain("Locked dependencies");
  expect(markdown).not.toContain("Where this affects our system");
  expect(markdown).not.toContain("Locked dependency evidence: [");
});


test("CVE.org, NIST and known GitHub records are linked above the description", () => {
  const markdown = cveAlertMarkdown({ id: "GHSA-2345-6789-cfgh", aliases: ["CVE-2026-1234"], title: "Issue", severity: "high", description: "Description text", url: "https://osv.dev/vulnerability/GHSA-2345-6789-cfgh" });
  expect(markdown).toContain("[CVE.org](https://www.cve.org/CVERecord?id=CVE-2026-1234)");
  expect(markdown).toContain("[NIST NVD](https://nvd.nist.gov/vuln/detail/CVE-2026-1234)");
  expect(markdown).toContain("[GitHub](https://github.com/advisories/GHSA-2345-6789-cfgh)");
  expect(markdown).not.toContain("GitHub search");
  expect(markdown).not.toContain("cveawg.mitre.org");
  expect(markdown.indexOf("**Advisory records:**")).toBeLessThan(markdown.indexOf("Description text"));
});

test("GHSA-only advisories link their source without inventing a CVE", () => {
  const markdown = cveAlertMarkdown({ id: "GHSA-2345-6789-cfgh", title: "Issue", severity: "high", url: "https://github.com/advisories/GHSA-2345-6789-cfgh" });
  expect(markdown).toContain("[GitHub](https://github.com/advisories/GHSA-2345-6789-cfgh)");
  expect(markdown).not.toContain("nist.gov");
  expect(markdown).not.toContain("cve.org");
  expect(markdown).not.toContain("cveawg.mitre.org");
});


test("CVE without a known GHSA links GitHub search rather than inventing an advisory", () => {
  const markdown = cveAlertMarkdown({ id: "CVE-2026-105862", title: "Issue", severity: "high", url: "https://example.com/advisory" });
  expect(markdown).toContain("[GitHub search](https://github.com/advisories?query=CVE-2026-105862)");
  expect(markdown).not.toContain("github.com/advisories/GHSA-");
});


test("repository context links the repository and lockfile, with reasoning above the table", () => {
  const markdown = cveSystemContextMarkdown({ targetRepository: "teamclara/Clara_V1", dependencyEvidence: [{ name: "payload", ecosystem: "npm", version: "3.89.0", path: "src/website/pnpm-lock.yaml" }] });
  expect(markdown).toContain("[teamclara/Clara\\_V1](https://github.com/teamclara/Clara_V1)");
  expect(markdown).toContain("[src/website/pnpm-lock.yaml](https://github.com/teamclara/Clara_V1/blob/HEAD/src/website/pnpm-lock.yaml)");
  expect(markdown.indexOf("Locked versions match")).toBeLessThan(markdown.indexOf("### Locked dependencies"));
});
test("unresolved current repositories and unsafe paths never produce invented GitHub links", () => {
  expect(cveSystemContextMarkdown({ targetRepository: "current", dependencyEvidence: [{ name: "a", ecosystem: "npm", version: "1", path: "uv.lock" }] })).not.toContain("github.com");
  expect(cveSystemContextMarkdown({ targetRepository: "example/repo", dependencyEvidence: [{ name: "a", ecosystem: "npm", version: "1", path: "../outside.lock" }] })).not.toContain("/blob/");
});
