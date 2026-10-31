import { expect, test } from "bun:test";
import { remediationIdentity, remediationPackages } from "./cveRemediation";
import { extractHookScope } from "../app/hooks/match";
import { HookQueue } from "../app/hookQueue";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CveAlert } from "./cve";

const alert = (id: string, path: string, version = "7.30.0"): CveAlert => ({
  schema: "errandd.cve.v1", id, aliases: [id], source: "osv", title: id,
  severity: "high", score: null, description: "", updatedAt: "", url: "",
  project: "", products: [], ecosystems: ["npm"], languages: [], technologies: [],
  affected: [], references: [], rejected: false, test: false,
  targetRepository: "TeamClara/Clara_V1",
  dependencyEvidence: [{ name: "undici", ecosystem: "npm", version, path }],
});

test("advisory, source, range, generation, version and lockfile changes reuse one package scope", () => {
  const a = alert("CVE-2026-109869", "src/website/pnpm-lock.yaml");
  const b = { ...alert("CVE-2026-109829", "src/ehr/pnpm-lock.yaml", "6.28.0"), source: "npm" as const, dependencyScanGeneration: 4, affected: [{ different: "range" }] };
  expect(extractHookScope("cve:alert", a)).toBe(extractHookScope("cve:alert", b));
  expect(extractHookScope("cve:alert", b)).toStartWith("cve-remediation-");
  expect(extractHookScope("cve:alert", { ...b, targetRepository: "other/repo" })).not.toBe(extractHookScope("cve:alert", a));
  expect(extractHookScope("cve:alert", { ...b, dependencyEvidence: [{ ...b.dependencyEvidence![0], ecosystem: "PyPI" }] })).not.toBe(extractHookScope("cve:alert", a));
});

test("coordinates are normalized and independent of order and duplicate paths", () => {
  const a = [{ name: "Foo_Bar", ecosystem: "Python" }, { name: "other", ecosystem: "PyPI" }];
  const b = [{ name: "other", ecosystem: "pip" }, { name: "foo.bar", ecosystem: "pypi" }, { name: "foo-bar", ecosystem: "PyPI" }];
  expect(remediationIdentity("ORG/Repo", a)).toBe(remediationIdentity("org/repo", b));
  expect(remediationIdentity("org/repo", a)).not.toBe(remediationIdentity("org/repo", a.slice(0, 1)));
});

test("structured feed coordinates join scanned packages; unknown products remain advisory scoped", () => {
  const scanned = alert("CVE-2026-109869", "lock.yaml");
  const feed = { ...scanned, dependencyEvidence: undefined, affected: [{ package: { name: "undici", ecosystem: "npm" } }] };
  expect(extractHookScope("cve:alert", feed)).toBe(extractHookScope("cve:alert", scanned));
  expect(remediationPackages({ ...feed, affected: [...feed.affected, { product: "unknown" }] })).toEqual([]);
  expect(extractHookScope("cve:alert", { ...scanned, dependencyEvidence: undefined })).toStartWith("cve-2026-109869-");
});

test("queue coalesces eight advisories across paths into one durable thread without losing evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "cve-remediation-"));
  const queue = new HookQueue(join(dir, "queue.sqlite"));
  try {
    const scopes = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const payload = alert(`CVE-2026-${109869 + i}`, i % 2 ? "src/ehr/pnpm-lock.yaml" : "src/frontend/pnpm-lock.yaml");
      const scope = extractHookScope("cve:alert", payload)!;
      scopes.add(scope);
      queue.enqueue({ id: payload.id, threadId: `security:hook:${scope}`, jobName: "security", event: "cve:alert", scope, payload });
    }
    expect(scopes.size).toBe(1);
    const messages = queue.claimThread(`security:hook:${[...scopes][0]}`);
    expect(messages).toHaveLength(8);
    expect(new Set(messages.map(message => (message.payload as CveAlert).id)).size).toBe(8);
  } finally { queue.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("restart rehomes old pending CVE chats and preserves running history", () => {
  const dir = mkdtempSync(join(tmpdir(), "cve-migration-"));
  const path = join(dir, "queue.sqlite");
  let queue = new HookQueue(path);
  try {
    const a = alert("CVE-2026-109869", "src/ehr/pnpm-lock.yaml");
    const b = alert("CVE-2026-109829", "src/frontend/pnpm-lock.yaml");
    for (const payload of [a, b]) queue.enqueue({ id: payload.id, threadId: `security:hook:${payload.id}`, jobName: "security", event: "cve:alert", scope: payload.id, payload });
    queue.enqueue({ id: "history", threadId: "security:hook:history", jobName: "security", event: "cve:alert", scope: "history", payload: a });
    queue.claimThread("security:hook:history");
    queue.close();
    queue = new HookQueue(path);
    const shared = `security:hook:${extractHookScope("cve:alert", a)}`;
    expect(queue.claimThread(shared).map(message => message.id).sort()).toEqual([a.id, b.id].sort());
    expect(queue.list({ threadId: "security:hook:history" })[0]?.status).toBe("running");
  } finally { queue.close(); rmSync(dir, { recursive: true, force: true }); }
});
