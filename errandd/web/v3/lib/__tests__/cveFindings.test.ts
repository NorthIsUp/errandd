import type { TreeItem } from "../tree";

import { expect, test } from "bun:test";
import { cvePullRequests, mergeCveFindings } from "../cveFindings";
import { buildThreadCatalog, searchThreads } from "../threadCatalog";
import { cveFindingKey, type CveFindingSummary } from "../../../../shared/cveSubscriptions";
const summary = (job = "security"): CveFindingSummary => ({
  key: cveFindingKey(job, "example/backend", "CVE-2020-12345"),
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
