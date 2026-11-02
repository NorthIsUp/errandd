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

test("repositories and states stay separate while different fixes share a remediation group", () => {
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
  ).toHaveLength(3);
});

test("unknown and conflicting fixes share work without claiming a common fixed version", () => {
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
  expect(groups).toHaveLength(1);
  expect(groups.every((group) => group.version === null)).toBe(true);
});

test("pagination counts remediation groups without splitting their CVEs", () => {
  const members = [item("a"), item("b"), item("c")];
  const other = item("d");
  other.finding!.packages = [{ name: "other", ecosystem: "PyPI" }];
  const groups = groupCveItems([...members, other]);
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


test("subscription ownership does not split identical repository and package groups", () => {
  const a = item("CVE-2026-12345");
  const b = item("CVE-2026-12346");
  b.finding!.job = "another-subscription";
  expect(groupCveItems([a, b])).toHaveLength(1);
});

test("a shared remediation conversation appears once at group level, not beneath sibling CVEs", () => {
  const a = item("a");
  const b = item("b");
  const shared = { threadId: "security:hook:cve-remediation-package", jobName: "security", status: "done" as const, outcome: "ok" as const, lastAt: 10 };
  for (const member of [a, b]) {
    member.finding!.remediationScope = "cve-remediation-package";
    member.routines = [shared];
  }
  const group = groupCveItems([a, b])[0]!;
  expect(group.sharedChat?.routines).toEqual([shared]);
  expect(group.sharedChat?.title).toBe("pypdf remediation chat");
  expect(group.items.every(member => member.routines.length === 0)).toBe(true);
  expect(a.routines).toEqual([shared]);
});

test("legacy findings without package metadata retain their conversation", () => {
  const legacy = item("legacy");
  delete legacy.finding!.packages;
  legacy.finding!.remediationScope = "cve-remediation-legacy";
  legacy.routines = [{ threadId: "security:hook:cve-remediation-legacy", jobName: "security", status: "done", outcome: "ok", lastAt: 10 }];
  const group = groupCveItems([legacy])[0]!;
  expect(group.sharedChat).toBeUndefined();
  expect(group.items[0].routines).toEqual(legacy.routines);
});
