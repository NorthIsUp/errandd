import type { TreeItem } from "../tree";

import { expect, test } from "bun:test";
import { cvePullRequests, mergeCveFindings } from "../cveFindings";
import { buildThreadCatalog, searchThreads } from "../threadCatalog";
import { cveFindingKey, type CveFindingSummary } from "../../../../shared/cveSubscriptions";
const summary = (job = "security"): CveFindingSummary => ({
  key: cveFindingKey("example/backend", "CVE-2020-12345"),
  id: "CVE-2020-12345",
  aliases: ["CVE-2020-12345", "GHSA-2345-6789-cfgh"],
  job,
  repository: "example/backend",
  title: "Historical dependency issue",
  status: "resolved",
  severity: "high",
  updatedAt: 1234,
  packageNames: ["django"],
});
test("cached findings never fabricate chats without a hook delivery", () => {
  const merged = mergeCveFindings({ source: "cve", label: "CVEs", items: [] }, [summary()]);
  expect(merged.items).toEqual([]);
  expect(buildThreadCatalog([merged], [], [])).toEqual([]);
});
test("CVE findings join existing real assessment threads and collapse overlapping subscriptions", () => {
  const merged = mergeCveFindings(
    {
      source: "cve",
      label: "CVEs",
      items: [
        {
          key: "scope",
          name: "GHSA-2345-6789-cfgh",
          repo: "example/backend",
          title: "existing",
          lastAt: 1,
          routines: [
            {
              threadId: "real-agent-thread",
              jobName: "security",
              status: "done",
              outcome: "ok",
              lastAt: 1,
            },
          ],
        },
      ],
    },
    [summary(), summary("another")],
  );
  expect(merged.items).toHaveLength(1);
  const entry = buildThreadCatalog([merged], [], []).find((entry) => entry.finding);
  expect(entry?.threadId).toBe("real-agent-thread");
  expect(searchThreads(buildThreadCatalog([merged], [], []), "django resolved backend")).toHaveLength(1);
});

test("CVE mirrors retain canonical PR objects and match exact aliases within the repository", () => {
  const finding = summary();
  const item = { key: "cve", title: finding.id, finding, lastAt: 1, routines: [] };
  const pr = (key: string, repo: string, title: string): TreeItem => ({
    key, repo, title, num: 12, lastAt: 1, routines: [],
  });
  const direct = pr("direct", finding.repository, "fix CVE-2020-12345");
  const alias = pr("alias", "Example/Backend", "fix ghsa-2345-6789-cfgh");
  const candidates = [direct, alias,
    pr("other-repo", "other/backend", direct.title),
    pr("prefix", finding.repository, "fix CVE-2020-123456"),
    pr("unrelated", finding.repository, "upgrade django"),
  ];
  const matches = cvePullRequests(item, candidates);
  expect(matches).toEqual([direct, alias]);
  expect(matches[0]).toBe(direct);
  expect(matches[1]).toBe(alias);
  expect(cvePullRequests({ key: item.key, title: item.title, lastAt: 1, routines: [], repo: finding.repository, name: finding.id }, candidates)).toEqual([direct]);
});


test("all advisories on a package chat retain the same real thread and independent findings", () => {
  const a = { ...summary(), remediationScope: "cve-remediation-shared", status: "affected" as const };
  const b = { ...a, key: "second", id: "CVE-2026-109869", aliases: ["CVE-2026-109869"] };
  const routines: TreeItem["routines"] = [{ threadId: "one-real-thread", jobName: "security", status: "pending", outcome: null, lastAt: 1 }];
  const merged = mergeCveFindings({ source: "cve", label: "CVEs", items: [{
    key: a.remediationScope, title: a.id, name: a.id, repo: a.repository, lastAt: 1, routines,
  }] }, [a, b]);
  expect(merged.items.map(item => item.finding?.id).sort()).toEqual([a.id, b.id].sort());
  expect(merged.items.every(item => item.routines === routines)).toBe(true);
  expect(new Set(merged.items.flatMap(item => item.routines.map(ref => ref.threadId))).size).toBe(1);
});

test("legacy and grouped copies become one metadata-backed subject without losing either real thread", () => {
  const finding = { ...summary(), status: "affected" as const, remediationScope: "cve-remediation-shared" };
  const ref = (threadId: string): TreeItem["routines"][number] => ({ threadId, jobName: "security", status: "done", outcome: "ok", lastAt: 1 });
  const old: TreeItem = { key: "legacy-ghsa", repo: "Example/Backend", name: "GHSA-2345-6789-cfgh", title: "old raw title", routines: [ref("legacy-thread")], lastAt: 1 };
  const current: TreeItem = { ...old, key: finding.remediationScope, name: finding.id, routines: [ref("group-thread")] };
  const merged = mergeCveFindings({ source: "cve", label: "CVEs", items: [current, old] }, [finding]);
  expect(merged.items).toHaveLength(1);
  expect(merged.items[0]?.finding).toBe(finding);
  expect(merged.items[0]?.routines.map(value => value.threadId).sort()).toEqual(["group-thread", "legacy-thread"]);
  expect(old.routines).toHaveLength(1);
  expect(current.routines).toHaveLength(1);
  const resolved = mergeCveFindings({ source: "cve", label: "CVEs", items: [old, current] }, [{ ...finding, status: "resolved" }]);
  expect(resolved.items.filter(item => !item.finding || item.finding.status === "affected")).toHaveLength(0);
});
