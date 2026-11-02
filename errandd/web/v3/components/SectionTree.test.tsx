import { groupCveItems } from "../lib/cveGroups";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionTree } from "./SectionTree";
import type { TreeItem } from "../lib/tree";

test("CVE subjects reuse the disclosure and show every real thread", () => {
  const now = Date.now();
  const item: TreeItem = { key: "finding", title: "Vulnerability", lastAt: now,
    routines: ["legacy-check", "shared-check"].map(threadId => ({ threadId, jobName: threadId, status: "done", outcome: "ok", lastAt: now })),
    finding: { key: "finding", id: "CVE-2026-12345", aliases: ["CVE-2026-12345"], job: "security", repository: "example/backend", title: "Vulnerability", severity: "high", status: "affected", updatedAt: now, packageNames: ["pypdf"], technologies: ["python"] } };
  const html = renderToStaticMarkup(<SectionTree sections={[{ source: "cve", label: "CVEs", items: [item] }]}
    activeThreadId="legacy-check" onSelectThread={() => {}} openMap={{ "sec:cve": true, "item:finding": true }}
    onToggleNode={() => {}} sortMode="recent" onSortChange={() => {}} />);
  expect(html).toContain("pypdf • CVE-2026-12345");
  expect(html).toContain("legacy-check");
  expect(html).toContain("shared-check");
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('Affected technology: Python');
});

test("Affected hides completed siblings and renders the package chat once", () => {
  const now = Date.now();
  const scope = "cve-remediation-payload";
  const shared = { threadId: `security:hook:${scope}`, jobName: "security", status: "done" as const, outcome: "ok" as const, lastAt: now };
  const items: TreeItem[] = ["affected", "affected", "not_affected"].map((status, index) => ({
    key: `finding-${index}`, title: `Vulnerability ${index}`, lastAt: now, routines: [shared],
    finding: { key: `finding-${index}`, id: `CVE-2026-1234${index}`, aliases: [`CVE-2026-1234${index}`], job: "security", repository: "example/backend", title: `Vulnerability ${index}`, severity: "high", status: status as "affected" | "not_affected", updatedAt: now, packageNames: ["payload"], packages: [{ name: "payload", ecosystem: "npm" }], remediationScope: scope },
  }));
  const html = renderToStaticMarkup(<SectionTree sections={[{ source: "cve", label: "CVEs", items }]}
    activeThreadId={shared.threadId} onSelectThread={() => {}} openMap={{ "sec:cve": true, [groupCveItems(items.filter(item => item.finding?.status === "affected"))[0]!.key]: true }}
    onToggleNode={() => {}} sortMode="recent" onSortChange={() => {}} />);
  expect(html).not.toContain("CVE-2026-12342");
  expect(html).toContain("payload · 2 CVEs");
  expect(html).toContain("CVE-2026-12340");
  expect(html).toContain("CVE-2026-12341");
  expect(html.match(/>payload remediation chat</g)).toHaveLength(1);
});
