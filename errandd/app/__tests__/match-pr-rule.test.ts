import { describe, expect, test } from "bun:test";
import type { PrPayload } from "../hooks/match";
import { evalPrRule, matchPrRule, prRuleSkipReason } from "../hooks/match";
import type { PrRule } from "../hooks/schema";

const pr = (over: Partial<PrPayload> = {}): PrPayload => ({
  action: "opened",
  user: "alice",
  repo: "org/app",
  baseBranch: "feature/x",
  labels: ["needs-review"],
  draft: false,
  ...over,
});

const rule = (over: Partial<PrRule> = {}): PrRule => ({
  repo: ["*"],
  user: ["*"],
  action: [],
  branch: [],
  draft: "any",
  labels: [],
  ...over,
});

describe("evalPrRule — match + reason agree on every dimension", () => {
  test("fully-open rule matches", () => {
    expect(evalPrRule(rule(), pr())).toEqual({ ok: true });
    expect(matchPrRule(rule(), pr())).toBe(true);
  });

  test("branch filter reason", () => {
    const r = rule({ branch: ["!main"] });
    expect(matchPrRule(r, pr({ baseBranch: "main" }))).toBe(false);
    expect(prRuleSkipReason([r], pr({ baseBranch: "main" }))).toContain("base branch");
  });

  // The bug: prRuleSkipReason used to omit labels and report the generic
  // "no PR rule matched" for a label-rejected PR.
  test("required label absent → label-specific reason (was 'no PR rule matched')", () => {
    const r = rule({ labels: ["ready"] });
    const p = pr({ labels: ["needs-review"] });
    expect(matchPrRule(r, p)).toBe(false);
    const reason = prRuleSkipReason([r], p);
    expect(reason).toBe("required label `ready` not present");
  });

  test("excluded label present → reason names the label", () => {
    const r = rule({ labels: ["!wip"] });
    const p = pr({ labels: ["wip", "needs-review"] });
    expect(matchPrRule(r, p)).toBe(false);
    expect(prRuleSkipReason([r], p)).toBe("excluded label `wip` present");
  });

  test("required label present → matches", () => {
    const r = rule({ labels: ["needs-review"] });
    expect(evalPrRule(r, pr())).toEqual({ ok: true });
  });
});
