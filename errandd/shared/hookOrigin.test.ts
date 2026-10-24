import { expect, test } from "bun:test";
import { hookOrigin } from "./hookOrigin";

test("hook headers preserve provider, named commenter and action", () => {
  expect(hookOrigin("## Incoming hook · github issue_comment\n\n**action:** edited · **author:** alice\n\nHello")).toEqual({ provider: "github", event: "issue_comment", action: "edited", author: "alice" });
  expect(hookOrigin("## Incoming hook · sentry issue.created\n\nauthor: sentry[bot]")?.provider).toBe("sentry");
  expect(hookOrigin("## Incoming hook · datadog monitor.alert")?.provider).toBe("datadog");
  expect(hookOrigin("## Incoming hook · custom ping")?.provider).toBe("webhook");
});

test("thread provenance covers legacy hooks without attributing ordinary chat", () => {
  expect(hookOrigin("## Hook payload\n\nauthor: bob", "pr-review:hook:1")).toEqual({ provider: "github", author: "bob" });
  expect(hookOrigin("I saw a github issue_comment from author: alice", "pr-review:hook:1")).toBeNull();
});
