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
