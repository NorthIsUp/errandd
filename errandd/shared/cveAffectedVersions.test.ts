import { expect, test } from "bun:test";
import { affectedVersionRows } from "./cveAffectedVersions";
import { remediationFixedVersions } from "./cveRemediation";

test("PyPI audit fixed_in survives canonical version projection", () => {
  const rows = affectedVersionRows([{ package: { name: "pypdf", ecosystem: "PyPI" }, versions: ["6.21.2"], fixed_in: ["6.21.3"] }]);
  expect(rows).toEqual([{ product: "pypdf", range: "6.21.2", fixed: "6.21.3" }]);
  expect(remediationFixedVersions(rows, [{ name: "pypdf", ecosystem: "PyPI" }])).toEqual(["6.21.3"]);
});

test("each PyPI patch branch is retained and absent fixes remain unknown", () => {
  expect(affectedVersionRows([{ package: { name: "library" }, versions: ["1.0"], fixed_in: ["1.1", "2.1"] }]).map(row => row.fixed)).toEqual(["1.1", "2.1"]);
  expect(affectedVersionRows([{ package: { name: "library" }, versions: ["1.0"], fixed_in: [] }])[0].fixed).toBe("Not specified");
});
