import { expect, test } from "bun:test";
import type { QueueMessage } from "../../api/hooks";
import type { SessionInfo } from "../../api/sessions";
import { buildThreadCatalog, searchThreads } from "./threadCatalog";
import type { SidebarTree } from "./tree";

const ref = { threadId: "review:hook:pr-42", jobName: "review", status: "done" as const, outcome: null, lastAt: 100 };
const tree: SidebarTree = [{ source: "github", label: "Pull Requests", items: [{ key: "org/repo#42", title: "#42 — Déploiement", repo: "org/repo", lastAt: 100, routines: [ref, { ...ref, lastAt: 50 }] }] }];
const session = (overrides: Partial<SessionInfo>): SessionInfo => ({ id: "manual", agent: "codex", channel: "web", lastUsedAt: "2026-10-24T12:00:00Z", createdAt: "2026-10-24T12:00:00Z", turnCount: 1, firstMessage: "", lastMessage: "", closed: false, ...overrides });

test("Cmd-K searches cached metadata, authors, filenames and recent manual sessions without duplicate threads", () => {
  const messages = [{ threadId: ref.threadId, updatedAt: 100, fields: [{ label: "author", value: "Maya" }, { label: "branch", value: "release/october" }] }] as QueueMessage[];
  const sessions = [session({ threadId: ref.threadId, trigger: { kind: "hook", event: "issue_comment", actor: "Noah" } }), session({ title: "Plan the rollout" }), session({ id: "closed", closed: true })];
  const before = JSON.stringify({ tree, messages, sessions });
  const entries = buildThreadCatalog(tree, messages, sessions);
  expect(entries).toHaveLength(2);
  expect(searchThreads(entries, "42 review.md maya").map(entry => entry.threadId)).toEqual([ref.threadId]);
  expect(searchThreads(entries, "deploiement release/october noah")).toHaveLength(1);
  expect(searchThreads(entries, "codex rollout")[0]?.threadId).toBe("manual");
  expect(searchThreads(entries, "codex rollout")[0]?.status).toBeNull();
  expect(searchThreads(entries, "not found")).toHaveLength(0);
  expect(JSON.stringify({ tree, messages, sessions })).toBe(before);
});

test("shared CVE remediation chats never inherit a single advisory title or verdict", () => {
  const ref = { threadId: "security:hook:cve-remediation-payload", jobName: "security", status: "done" as const, outcome: "ok" as const, lastAt: 1 };
  const items = ["CVE-2026-12345", "CVE-2026-12346"].map(id => ({
    key: id, title: `${id} — a specific advisory`, lastAt: 1, routines: [ref],
    finding: { key: id, id, aliases: [id], job: "security", repository: "example/backend", title: "A specific advisory", severity: "high", status: "affected" as const, updatedAt: 1, packageNames: ["payload"], remediationScope: "cve-remediation-payload" },
  }));
  const entries = buildThreadCatalog([{ source: "cve", label: "CVEs", items }], [], []);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.title).toBe("payload remediation chat");
  expect(entries[0]?.finding).toBeUndefined();
});
