import { expect, test } from "bun:test";
import { queuedHookParts } from "../ui/services/queuedHookParts";
import type { QueuedMessage } from "../hookQueue";
import { hookOrigin } from "../../shared/hookOrigin";

const message = (id: string, event: string, payload: unknown, enqueuedAt: number): QueuedMessage => ({ id, event, payload, enqueuedAt, threadId: "security:hook:cve-2026-1234", jobName: "security", scope: "cve-2026-1234", status: "pending", attempts: 0, rateLimitAttempts: 0, notBefore: 0, prRepo: null, prNumber: null, outcome: null, error: null, updatedAt: enqueuedAt });
test("queued CVE context is an ordinary incoming hook message with description and references", () => {
  const alert = { schema: "errandd.cve.v1", id: "CVE-2026-1234", title: "Test issue", description: "A dependency vulnerability requiring investigation.", severity: "high", source: "osv", url: "https://example.com/advisory", references: ["https://example.com/fix"], products: [], affected: [], ecosystems: [], languages: [], technologies: [], rejected: false, test: false };
  const parts = queuedHookParts([message("cve", "cve:alert", alert, 1)]);
  expect(parts).toHaveLength(2);
  expect(parts[1]).toMatchObject({ kind: "system", contextType: "repository-analysis" });
  const part = parts[0];
  expect(part.kind).toBe("text");
  if (part.kind !== "text") throw Error("Expected ordinary message");
  expect(part.role).toBe("user");
  expect(hookOrigin(part.markdown)?.provider).toBe("cve");
  expect(part.markdown).toContain(alert.description);
  expect(part.markdown).toContain("https://example.com/fix");
  expect(part.markdown).not.toContain("tracking issue");
});
test("hook context and web replies retain chronological order and stable delivery IDs", () => {
  const parts = queuedHookParts([message("reply", "web:message", { text: "Investigate this" }, 2), message("github", "issue_comment", {}, 1)]);
  expect(parts.map(part => part.id)).toEqual(["queued-hook:github", "queued-hook:reply"]);
  expect(parts[1]).toMatchObject({ kind: "text", role: "user", markdown: "Investigate this" });
});


test("pending hook shows the actual configured instructions once and never invents defaults", () => {
  const parts = queuedHookParts([message("first", "cve:alert", {}, 1), message("second", "cve:alert", {}, 2)], [{ name: "security", prompt: "# Custom CVE policy\nCreate a Linear ticket before opening a fix PR." }]);
  expect(JSON.stringify(parts)).toContain("Create a Linear ticket before opening a fix PR.");
  expect(JSON.stringify(parts).match(/Custom CVE policy/g)).toHaveLength(1);
  expect(JSON.stringify(parts)).not.toContain("Assess and remediate");
});


test("queued instructions show the same configured ticket destination as the agent prompt", () => {
  const parts = queuedHookParts([message("first", "cve:alert", {}, 1)], [{ name: "security", prompt: "# Job\nInvestigate" }], "security-team");
  expect(JSON.stringify(parts)).toContain('security-team');
  expect(JSON.stringify(parts)).toContain('Tracking issue destination');
});


test("CVE instructions follow a divider after the hook context", () => {
  const parts = queuedHookParts([message("first", "cve:alert", {}, 1)], [{ name: "security", prompt: "# Job\nInvestigate" }]);
  const part = parts[0];
  if (part.kind !== "text") throw Error("Expected a hook message");
  expect(part.markdown).toContain("\n\n---\n\n# Job\nInvestigate");
});


test("security tracker URL is not added to unrelated webhook instructions", () => {
  const parts=queuedHookParts([message("pr","pull_request",{},1)],[{name:"security",prompt:"# Review\nReview a PR."}],"old-project","old-team","https://github.com/example/security/issues");
  expect(JSON.stringify(parts)).not.toContain("https://github.com/example/security/issues");
  expect(JSON.stringify(parts)).not.toContain("old-project");
});
