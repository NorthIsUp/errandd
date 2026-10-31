import { expect, test } from "bun:test";
import { groupCveItems } from "../cveGroups";
import { pageItems } from "../paging";
import type { TreeItem } from "../tree";

const item = (id: string, range = "< 6.21.3", fixed = "6.21.3"): TreeItem => ({
  key: id,
  title: id,
  lastAt: 1,
  routines: [],
  finding: {
    key: id,
    id,
    aliases: [id],
    job: "security",
    repository: "teamclara/Clara_V1",
    title: id,
    severity: "high",
    status: "affected",
    updatedAt: 1,
    packageNames: ["pypdf"],
    packages: [{ name: "pypdf", ecosystem: "PyPI" }],
    affectedVersions: [{ product: "pypdf", range, fixed }],
  },
});

test("shared affected ranges and fixed versions form one group with original CVE objects", () => {
  const a = item("CVE-2026-119209");
  const b = item("CVE-2026-119205", "<6.21.3");
  const groups = groupCveItems([a, b]);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.items).toEqual([a, b]);
  expect(groups[0]?.items[0]).toBe(a);
  expect(groups[0]?.version).toEqual({
    product: "pypdf",
    range: "< 6.21.3",
    fixed: "6.21.3",
  });
});

test("different repositories, states, ranges or fixes do not collapse into one group", () => {
  const a = item("a");
  const otherRepo = item("b");
  otherRepo.finding!.repository = "other/backend";
  const resolved = item("c");
  resolved.finding!.status = "resolved";
  expect(
    groupCveItems([
      a,
      otherRepo,
      resolved,
      item("d", "<6.21.4", "6.21.4"),
      item("e", "<6.21.3", "6.21.4"),
    ]),
  ).toHaveLength(5);
});

test("missing, unspecified and conflicting fixes remain individual findings", () => {
  const missing = item("missing");
  missing.finding!.affectedVersions = [];
  const unknown = item("unknown", "<6.21.3", "Not specified");
  const conflict = item("conflict");
  conflict.finding!.affectedVersions!.push({
    product: "pypdf",
    range: "<6.21.4",
    fixed: "6.21.4",
  });
  const groups = groupCveItems([missing, unknown, conflict]);
  expect(groups).toHaveLength(3);
  expect(groups.every((group) => group.version === null)).toBe(true);
});

test("pagination counts remediation groups without splitting their CVEs", () => {
  const members = [item("a"), item("b"), item("c")];
  const groups = groupCveItems([...members, item("d", "<6.21.4", "6.21.4")]);
  const page = pageItems(groups, "count", 1, 0, 1);
  expect(page.total).toBe(2);
  expect(page.items.flatMap((group) => group.items)).toEqual(members);
  expect(page.hasNext).toBe(true);
});

test("identical package names in distinct ecosystems never imply one remediation", () => {
  const python = item("python");
  const npm = item("npm");
  npm.finding!.packages = [{ name: "pypdf", ecosystem: "npm" }];
  expect(groupCveItems([python, npm])).toHaveLength(2);
  const legacy = item("legacy");
  delete legacy.finding!.packages;
  expect(groupCveItems([legacy, python])).toHaveLength(2);
});
