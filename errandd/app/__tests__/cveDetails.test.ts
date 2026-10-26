import { expect, test } from "bun:test";
import { affectedVersionRows } from "../../shared/cveAffectedVersions";
import { readCveAlert, readGithubAdvisory } from "../../shared/cve";
import { readOsvAdvisory } from "../cve-lockfiles";
import { cveAlertMarkdown } from "../../shared/cveMarkdown";

test("OSV intervals retain affected bounds and distinguish fixes from last-affected versions", () => {
  const rows = affectedVersionRows([{ package: { name: "django" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "5.0" }, { fixed: "5.1.2" }, { introduced: "5.2" }, { last_affected: "5.2.1" }] }] }]);
  expect(rows).toEqual([{ product: "django", range: ">= 5.0, < 5.1.2", fixed: "5.1.2" }, { product: "django", range: ">= 5.2, <= 5.2.1", fixed: "Not specified" }]);
  expect(affectedVersionRows([{ package: { name: "empty" }, ranges: [{ type: "SEMVER", events: [] }] }])).toEqual([]);
});
test("Git ranges are commit boundaries rather than version comparisons", () => {
  expect(affectedVersionRows([{ package: { name: "lib" }, ranges: [{ type: "GIT", events: [{ introduced: "abc" }, { fixed: "def" }] }] }])[0]?.range).toBe("Git commits from abc through def (exclusive)");
});
test("official CVE affected versions and explicit CWE classifications survive normalization", () => {
  const alert = readCveAlert({ cveMetadata: { cveId: "CVE-2026-1234", state: "PUBLISHED" }, containers: { cna: { affected: [{ vendor: "vendor", product: "payload", versions: [{ version: "< 3.90.0", status: "affected" }] }], problemTypes: [{ descriptions: [{ cweId: "CWE-79", description: "Cross-site scripting" }, { description: "Unclassified" }] }] } } });
  expect(alert?.weaknesses).toEqual([{ id: "CWE-79", name: "Cross-site scripting" }]);
  const markdown = cveAlertMarkdown(alert!);
  expect(markdown).toContain("### Affected versions");
  expect(markdown).toContain("3.90.0 (affected)");
  expect(markdown).toContain("[CWE-79](https://cwe.mitre.org/data/definitions/79.html)");
});
test("GitHub and OSV CWE metadata and patched versions are preserved", () => {
  const github = readGithubAdvisory({ ghsa_id: "GHSA-2345-6789-cfgh", type: "reviewed", cwes: [{ cwe_id: "CWE-770", name: "Resource allocation" }], vulnerabilities: [{ package: { name: "lib", ecosystem: "npm" }, vulnerable_version_range: "< 2.0.0", first_patched_version: { identifier: "2.0.0" } }] });
  expect(github?.weaknesses).toEqual([{ id: "CWE-770", name: "Resource allocation" }]);
  expect(affectedVersionRows(github!.affected)[0]).toEqual({ product: "lib", range: "< 2.0.0", fixed: "2.0.0" });
  expect(readOsvAdvisory({ id: "GHSA-2345-6789-cfgh", database_specific: { cwe_ids: ["CWE-770", "invalid"] } })?.weaknesses).toEqual([{ id: "CWE-770" }]);
});
