import { expect, test } from "bun:test";
import { mergeReportSources, packageAdvisory } from "./cveAdvisory";

test("package advisories retain native identities without fabricated GHSA fields", () => {
  const alert = packageAdvisory({
    source: "pypi",
    id: "PYSEC-2026-123",
    aliases: ["PYSEC-2026-123"],
    title: "Python report",
    description: "test",
    severity: "unknown",
    rejected: false,
    updatedAt: "",
    url: "https://pypi.org/pypi/example/1.0/json",
    references: [],
    affected: [],
    packages: [{ name: "example", ecosystem: "PyPI" }],
  });
  expect(alert.aliases).toEqual(["PYSEC-2026-123"]);
  expect(alert.ecosystems).toEqual(["pypi"]);
  expect(alert.languages).toEqual(["python"]);
  expect(JSON.stringify(alert)).not.toContain("GHSA-");
});

test("report identity survives timestamp changes and preserves the latest revision", () => {
  const report = {
    source: "Tailscale",
    url: "https://tailscale.com/security-bulletins/#example",
    updatedAt: "2026-10-28",
  };
  const reports = mergeReportSources(
    { sources: [report] },
    { sources: [{ ...report, updatedAt: "2026-10-29" }] },
    { sources: [report] },
  );
  expect(reports).toEqual([{ ...report, updatedAt: "2026-10-29" }]);
});

test("unknown report timestamps cannot replace a known publication revision", () => {
  const report = { source: "Tailscale", url: "https://tailscale.com/security-bulletins/#example", updatedAt: "2026-10-28" };
  expect(mergeReportSources({ sources: [report] }, { sources: [{ ...report, updatedAt: "" }] })).toEqual([report]);
});
