import { expect, test } from "bun:test";
import { mergeCveFindings } from "../cveFindings";
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
