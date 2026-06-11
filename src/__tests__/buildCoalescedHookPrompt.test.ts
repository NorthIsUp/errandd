import { describe, expect, test } from "bun:test";
import { buildCoalescedHookPrompt } from "../commands/start";
import type { QueuedMessage } from "../hookQueue";

function msg(over: Partial<QueuedMessage>): QueuedMessage {
  return {
    id: "d1",
    threadId: "job:hook:pr-1-x",
    jobName: "job",
    event: "pull_request",
    scope: "pr-1-x",
    payload: null,
    enqueuedAt: 0,
    status: "pending",
    attempts: 0,
    notBefore: 0,
    prRepo: null,
    prNumber: null,
    outcome: null,
    error: null,
    updatedAt: 0,
    ...over,
  };
}

const PR_OPENED = {
  action: "opened",
  repository: { full_name: "org/repo" },
  sender: { login: "alice" },
  pull_request: { number: 42, title: "Fix the flaky test", html_url: "https://gh/pr/42" },
};

describe("buildCoalescedHookPrompt — web:message branch (spec §8)", () => {
  test("single web:message renders raw payload.text, not a hook summary", () => {
    const out = buildCoalescedHookPrompt("JOB-PROMPT", "pr-1-x", [
      msg({ event: "web:message", payload: { type: "user-message", text: "ship it please" } }),
    ]);
    expect(out).toContain("ship it please");
    expect(out).not.toContain("Triggered by");
    expect(out).not.toContain("## Incoming hook");
    expect(out.trim().endsWith("JOB-PROMPT")).toBe(true);
  });

  test("web:message with missing text renders an empty block (no crash)", () => {
    const out = buildCoalescedHookPrompt("P", "s", [msg({ event: "web:message", payload: {} })]);
    expect(out).not.toContain("Triggered by");
    expect(out).toContain("P");
  });

  test("a normal hook message renders the compact Incoming hook block", () => {
    const out = buildCoalescedHookPrompt("P", "pr-1-x", [
      msg({ event: "pull_request", payload: PR_OPENED }),
    ]);
    expect(out).toContain("## Incoming hook · github pull_request");
    expect(out).toContain("org/repo#42 — Fix the flaky test");
    // No legacy boilerplate.
    expect(out).not.toContain("Triggered by");
    expect(out).not.toContain("delivery d1");
    expect(out).not.toContain("**repo**");
  });

  test("mixed batch: web:message text + a hook one-liner coalesced under a header", () => {
    const out = buildCoalescedHookPrompt("P", "pr-1-x", [
      msg({ id: "a", event: "web:message", payload: { type: "user-message", text: "hello" } }),
      msg({ id: "b", event: "pull_request", payload: { ...PR_OPENED, action: "synchronize" } }),
    ]);
    expect(out).toContain("## Incoming hooks (2) · pr-1-x");
    expect(out).toContain("hello");
    expect(out).toContain("pull_request · synchronize");
  });
});

describe("buildCoalescedHookPrompt — resume vs new session", () => {
  test("new session (default) includes the full routine prompt", () => {
    const out = buildCoalescedHookPrompt(
      "ROUTINE-INSTRUCTIONS",
      "pr-1-x",
      [msg({ event: "pull_request", payload: PR_OPENED })],
      true,
    );
    expect(out).toContain("## Incoming hook · github pull_request");
    expect(out.trim().endsWith("ROUTINE-INSTRUCTIONS")).toBe(true);
  });

  test("resume keeps the compact event block but DROPS the routine prompt", () => {
    const out = buildCoalescedHookPrompt(
      "ROUTINE-INSTRUCTIONS",
      "pr-1-x",
      [msg({ event: "pull_request_review_comment", payload: { action: "created" } })],
      false,
    );
    // The compact event context is still present...
    expect(out).toContain("## Incoming hook · github pull_request_review_comment");
    expect(out).toContain("Handle with the context you already have.");
    // ...but the routine boilerplate is NOT re-sent.
    expect(out).not.toContain("ROUTINE-INSTRUCTIONS");
  });

  test("resume with multiple events uses the coalesced header + nudge, no prompt", () => {
    const out = buildCoalescedHookPrompt(
      "ROUTINE-INSTRUCTIONS",
      "pr-1-x",
      [
        msg({ id: "a", event: "pull_request", payload: { ...PR_OPENED, action: "synchronize" } }),
        msg({ id: "b", event: "pull_request_review_comment", payload: { action: "created" } }),
      ],
      false,
    );
    expect(out).toContain("## Incoming hooks (2) · pr-1-x");
    expect(out).toContain("Handle with the context you already have.");
    expect(out).not.toContain("ROUTINE-INSTRUCTIONS");
  });
});

describe("buildCoalescedHookPrompt — full body reaches the prompt (rich, not one-lined)", () => {
  test("a bot comment keeps its body (meaningful, e.g. a review), capped at the rich limit", () => {
    // Past the rich cap (4000): kept up to the cap with a truncation tail, NOT
    // dropped to a one-line 600-char snippet.
    const out = buildCoalescedHookPrompt("P", "pr-9", [
      msg({
        event: "issue_comment",
        payload: {
          action: "created",
          repository: { full_name: "org/repo" },
          sender: { login: "greptile-bot" },
          issue: { number: 9, title: "T" },
          comment: { user: { login: "greptile-bot" }, body: "X".repeat(6000) },
        },
      }),
    ]);
    // The body is shown (just capped), not dropped with a suppression note.
    expect(out).not.toContain("(body suppressed");
    expect(out).toContain("XXXXXXXXXX");
    // Capped at the rich limit with the tail — far more than the old 600-char
    // bot one-liner, but not the full 6000 chars.
    expect(out).toContain("chars total]");
  });

  test("a multi-line human comment with a code fence survives as a blockquote", () => {
    const body = [
      "please rebase onto main, CI is red.",
      "",
      "```sh",
      "git rebase origin/main",
      "```",
    ].join("\n");
    const out = buildCoalescedHookPrompt("P", "pr-9", [
      msg({
        event: "issue_comment",
        payload: {
          action: "created",
          repository: { full_name: "org/repo" },
          sender: { login: "alice" },
          issue: { number: 9, title: "T" },
          comment: { user: { login: "alice" }, body },
        },
      }),
    ]);
    // Structure survives: each line is `> `-prefixed, the fence is intact, and
    // newlines are NOT collapsed into a single line.
    expect(out).toContain("> please rebase onto main, CI is red.");
    expect(out).toContain("> ```sh");
    expect(out).toContain("> git rebase origin/main");
  });
});
