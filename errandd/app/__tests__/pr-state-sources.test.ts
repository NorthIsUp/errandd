import { describe, expect, test } from "bun:test";
import { derivePrState, derivePrStateFromGraphql } from "../../shared/prState";
import { mergePrStates } from "../ui/routes/prs";

describe("draft PRs", () => {
  test("webhook: open + draft → draft", () => {
    expect(derivePrState({ state: "open", draft: true, mergeable_state: "clean" })).toBe("draft");
  });

  test("webhook: draft outranks a dirty merge state (a draft isn't actionable)", () => {
    expect(derivePrState({ state: "open", draft: true, mergeable_state: "dirty" })).toBe("draft");
  });

  test("webhook: a merged PR is never re-read as draft", () => {
    expect(derivePrState({ state: "closed", merged: true, draft: true })).toBe("merged");
  });
});

describe("derivePrStateFromGraphql", () => {
  test("MERGED is a first-class state (REST splits it into closed + merged)", () => {
    expect(derivePrStateFromGraphql({ state: "MERGED" })).toBe("merged");
  });

  test("CLOSED → closed", () => {
    expect(derivePrStateFromGraphql({ state: "CLOSED", mergeable: "CONFLICTING" })).toBe("closed");
  });

  test("OPEN + CONFLICTING → conflicted", () => {
    expect(derivePrStateFromGraphql({ state: "OPEN", mergeable: "CONFLICTING" })).toBe("conflicted");
  });

  test("OPEN + isDraft → draft", () => {
    expect(derivePrStateFromGraphql({ state: "OPEN", isDraft: true })).toBe("draft");
  });

  test("OPEN + UNKNOWN mergeability → open (mergeability is computed async)", () => {
    expect(derivePrStateFromGraphql({ state: "OPEN", mergeable: "UNKNOWN" })).toBe("open");
  });

  test("a missing node (deleted / no access) → unknown", () => {
    expect(derivePrStateFromGraphql(null)).toBe("unknown");
    expect(derivePrStateFromGraphql({})).toBe("unknown");
  });
});

describe("mergePrStates", () => {
  const key = "teamclara/Clara_V1#1";

  test("a freshly-polled open PR can't read merged from a stale store", () => {
    const merged = mergePrStates({ [key]: "open" }, { [key]: { state: "merged", mergeable: null } });
    expect(merged[key]?.state).toBe("open");
  });

  test("the store wins within the open states — it carries mergeability", () => {
    const merged = mergePrStates(
      { [key]: "open" },
      { [key]: { state: "conflicted", mergeable: false } },
    );
    expect(merged[key]).toEqual({ state: "conflicted", mergeable: false });
  });

  test("draft comes from the poll when the store knows nothing", () => {
    expect(mergePrStates({ [key]: "draft" }, {})[key]?.state).toBe("draft");
  });

  test("PRs absent from the open list keep their resolved terminal state", () => {
    const merged = mergePrStates({}, { [key]: { state: "merged", mergeable: null } });
    expect(merged[key]?.state).toBe("merged");
  });
});
