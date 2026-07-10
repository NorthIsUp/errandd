import { describe, expect, test } from "bun:test";
import { deliveryIdentityKey, queueIdentityKey } from "./deliveryKey";

describe("sentry identity is the issue id alone (state must not fork it)", () => {
  test("created and resolved deliveries for one issue share an identity", () => {
    const created = deliveryIdentityKey({
      event: "sentry:issue",
      pk: "7542475024",
      keys: { key1Label: "level", key1: "error", key2Label: "action", key2: "created" },
    });
    const resolved = deliveryIdentityKey({
      event: "sentry:issue",
      pk: "7542475024",
      keys: { key1Label: "level", key1: "error", key2Label: "action", key2: "resolved" },
    });
    expect(created).toBe("sentry:7542475024");
    expect(resolved).toBe(created);
  });

  test("queue row derives the same identity from its scope", () => {
    const queueKey = queueIdentityKey({
      event: "sentry:error",
      prNumber: null,
      scope: "sentry-issue-7542475024",
      keys: { key1Label: "level", key1: "error", key2Label: "action", key2: "created" },
    });
    expect(queueKey).toBe("sentry:7542475024");
  });

  test("sentry without a pk falls back to the generic key", () => {
    const key = deliveryIdentityKey({
      event: "sentry:error",
      pk: "",
      keys: { key1Label: "level", key1: "error", key2Label: "action", key2: "created" },
    });
    expect(key).toBe("pr=|k1=error|k2=created");
  });
});

describe("github identity keeps the full key (PR numbers collide across repos)", () => {
  test("delivery and queue row agree", () => {
    const d = deliveryIdentityKey({
      event: "pull_request",
      pk: "1542",
      keys: { key1Label: "action", key1: "opened", key2Label: "pr/branch", key2: "#1542" },
    });
    const q = queueIdentityKey({
      event: "pull_request",
      prNumber: 1542,
      scope: "pr-1542-fix-thing",
      keys: { key1Label: "action", key1: "opened", key2Label: "pr/branch", key2: "#1542" },
    });
    expect(d).toBe("pr=1542|k1=opened|k2=#1542");
    expect(q).toBe(d);
  });

  test("no discriminators at all → null (job-name fallback)", () => {
    expect(
      deliveryIdentityKey({
        event: "web:message",
        pk: "",
        keys: { key1Label: "", key1: "", key2Label: "", key2: "" },
      }),
    ).toBeNull();
  });
});
