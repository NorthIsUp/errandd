import { describe, expect, test } from "bun:test";
import {
  extractHookScope,
  matchDatadogRule,
  matchSentryRule,
  readDatadogPayload,
  readSentryPayload,
  renderHookSummaryMarkdown,
} from "../hooks/match";
import {
  buildHookEssentials,
  HOOK_LIMITS,
  isBotActor,
  prefilterReason,
  truncateText,
} from "../../shared/hookEssentials";
import {
  parseTriggers,
  defaultSentryRule,
  defaultDatadogRule,
  DEFAULT_DATADOG_PRIORITY_PATTERNS,
  PROD_SENTRY_PROJECT_PATTERNS,
} from "../hooks/schema";

const SENTRY_ISSUE = {
  action: "created",
  data: {
    issue: {
      id: "55",
      title: "TypeError: undefined is not a function",
      level: "error",
      culprit: "app/handlers/foo",
      count: 12,
      project: { slug: "clara-prod" },
      permalink: "https://sentry.io/issues/55/",
    },
  },
  actor: { type: "application", name: "Sentry" },
};

const DATADOG_ALERT = {
  id: "evt-1",
  monitor_id: "789",
  title: "High API latency",
  message: "p99 > 2s",
  type: "error",
  priority: "P1",
  transition: "Triggered",
  status: "Alert",
  aggreg_key: "cycle-abc",
  tags: "service:api,env:prod",
  link: "https://app.datadoghq.com/monitors/789",
};

describe("schema parsing", () => {
  test("sentry: true → prod-only default (not match-any)", () => {
    expect(parseTriggers([{ sentry: true }], undefined).hookConfig?.sentry).toEqual(
      defaultSentryRule(),
    );
    expect(defaultSentryRule().project).toEqual(PROD_SENTRY_PROJECT_PATTERNS);
  });
  test("sentry object without project → prod-only default", () => {
    const cfg = parseTriggers([{ sentry: { level: ["error"] } }], undefined).hookConfig;
    expect(cfg?.sentry).toEqual({
      project: [...PROD_SENTRY_PROJECT_PATTERNS],
      level: ["error"],
      action: [],
    });
  });
  test("sentry object normalizes lists (explicit project overrides the default)", () => {
    const cfg = parseTriggers(
      [{ sentry: { project: "clara-*", level: ["error", "fatal"] } }],
      undefined,
    ).hookConfig;
    expect(cfg?.sentry).toEqual({ project: ["clara-*"], level: ["error", "fatal"], action: [] });
  });
  test("sentry project: ['*'] opts back into all projects", () => {
    const cfg = parseTriggers([{ sentry: { project: ["*"] } }], undefined).hookConfig;
    expect(cfg?.sentry).toEqual({ project: ["*"], level: [], action: [] });
  });
  test("datadog object normalizes lists", () => {
    const cfg = parseTriggers(
      [{ datadog: { monitor: "789", priority: "P1" } }],
      undefined,
    ).hookConfig;
    expect(cfg?.datadog).toEqual({ monitor: ["789"], priority: ["P1"], type: [], tags: [] });
  });
  test("datadog: true → priority-floor default (not match-any) — P0-4", () => {
    expect(parseTriggers([{ datadog: true }], undefined).hookConfig?.datadog).toEqual(
      defaultDatadogRule(),
    );
    expect(defaultDatadogRule().priority).toEqual(DEFAULT_DATADOG_PRIORITY_PATTERNS);
    // The default does NOT match a low-priority/normal alert.
    const normal = readDatadogPayload({ ...DATADOG_ALERT, priority: "normal" })!;
    expect(matchDatadogRule(defaultDatadogRule(), normal)).toBe(false);
    // …but DOES match a real P1 alert.
    const p1 = readDatadogPayload(DATADOG_ALERT)!;
    expect(matchDatadogRule(defaultDatadogRule(), p1)).toBe(true);
  });
  test("datadog object without priority → priority-floor default", () => {
    const cfg = parseTriggers([{ datadog: { monitor: "789" } }], undefined).hookConfig;
    expect(cfg?.datadog).toEqual({
      monitor: ["789"],
      priority: [...DEFAULT_DATADOG_PRIORITY_PATTERNS],
      type: [],
      tags: [],
    });
  });
  test("datadog priority: ['*'] opts back into all priorities", () => {
    const cfg = parseTriggers([{ datadog: { priority: ["*"] } }], undefined).hookConfig;
    expect(cfg?.datadog).toEqual({ monitor: ["*"], priority: ["*"], type: [], tags: [] });
  });
  test("prs + sentry combine across list entries", () => {
    const cfg = parseTriggers([{ prs: true }, { sentry: true }], undefined).hookConfig;
    expect(cfg?.pr.length).toBe(1);
    expect(cfg?.sentry).toEqual(defaultSentryRule());
  });
});

describe("sentry matching", () => {
  test("project glob matches", () => {
    const p = readSentryPayload(SENTRY_ISSUE)!;
    expect(p.project).toBe("clara-prod");
    expect(matchSentryRule({ project: ["clara-*"], level: [], action: [] }, p)).toBe(true);
  });
  test("level filter excludes", () => {
    const p = readSentryPayload(SENTRY_ISSUE)!;
    expect(matchSentryRule({ project: ["*"], level: ["fatal"], action: [] }, p)).toBe(false);
    expect(matchSentryRule({ project: ["*"], level: ["error"], action: [] }, p)).toBe(true);
  });
  test("action filter", () => {
    const p = readSentryPayload(SENTRY_ISSUE)!;
    expect(matchSentryRule({ project: ["*"], level: [], action: ["resolved"] }, p)).toBe(false);
    expect(matchSentryRule({ project: ["*"], level: [], action: ["created"] }, p)).toBe(true);
  });
  test("prod default matches *-prod / prod-* / production, rejects staging+dev", () => {
    const rule = defaultSentryRule();
    const at = (slug: string) =>
      readSentryPayload({ ...SENTRY_ISSUE, data: { issue: { id: "1", project: { slug } } } })!;
    for (const slug of ["clara-prod", "prod-api", "production"]) {
      expect(matchSentryRule(rule, at(slug))).toBe(true);
    }
    for (const slug of ["clara-staging", "clara-dev", "prodigy", "preprod"]) {
      expect(matchSentryRule(rule, at(slug))).toBe(false);
    }
  });
  test("scope is the issue id", () => {
    expect(extractHookScope("sentry:issue", SENTRY_ISSUE)).toBe("sentry-issue-55");
  });
  test("markdown summary linkifies", () => {
    const md = renderHookSummaryMarkdown("sentry:issue", SENTRY_ISSUE);
    expect(md).toContain("clara-prod");
    expect(md).toContain("https://sentry.io/issues/55/");
    expect(md).not.toContain("breadcrumbs");
  });
});

describe("datadog matching", () => {
  test("monitor + priority + tags", () => {
    const p = readDatadogPayload(DATADOG_ALERT)!;
    expect(p.monitor).toBe("789");
    expect(p.tags).toEqual(["service:api", "env:prod"]);
    expect(
      matchDatadogRule({ monitor: ["789"], priority: ["P1"], type: [], tags: ["service:api"] }, p),
    ).toBe(true);
  });
  test("missing tag excludes", () => {
    const p = readDatadogPayload(DATADOG_ALERT)!;
    expect(
      matchDatadogRule({ monitor: ["*"], priority: [], type: [], tags: ["env:staging"] }, p),
    ).toBe(false);
  });
  test("negated tag excludes when present", () => {
    const p = readDatadogPayload(DATADOG_ALERT)!;
    expect(
      matchDatadogRule({ monitor: ["*"], priority: [], type: [], tags: ["!env:prod"] }, p),
    ).toBe(false);
  });
  test("empty tag list is no constraint → matches (P0-8 set-membership)", () => {
    const p = readDatadogPayload(DATADOG_ALERT)!;
    expect(matchDatadogRule({ monitor: ["*"], priority: [], type: [], tags: [] }, p)).toBe(true);
  });
  test("all-exclusion tag list allows all but the excluded (P0-8)", () => {
    const p = readDatadogPayload(DATADOG_ALERT)!;
    // service:api/env:prod present, but the only rule tag excludes env:staging
    // (absent) → nothing excluded → matches.
    expect(
      matchDatadogRule({ monitor: ["*"], priority: [], type: [], tags: ["!env:staging"] }, p),
    ).toBe(true);
  });
  test("scope prefers aggreg_key", () => {
    expect(extractHookScope("datadog:alert", DATADOG_ALERT)).toBe("dd-cycle-abc");
  });
  test("scope falls back to monitor", () => {
    const noAgg = { ...DATADOG_ALERT, aggreg_key: undefined };
    expect(extractHookScope("datadog:alert", noAgg)).toBe("dd-monitor-789");
  });
});

// ---------------------------------------------------------------------------
// Hook Context Diet — essentials layer
// ---------------------------------------------------------------------------

const PR_COMMENT = (login: string, body: string) => ({
  action: "created",
  repository: { full_name: "org/repo" },
  sender: { login },
  issue: { number: 42, title: "Fix the flaky test" },
  comment: { user: { login }, body, html_url: "https://gh/c/1" },
});

describe("truncateText — marker math", () => {
  test("under the limit passes through with 0 dropped", () => {
    expect(truncateText("hello world", 280)).toEqual({ text: "hello world", truncatedChars: 0 });
  });
  test("over the limit appends …⟨+N⟩ counting dropped chars", () => {
    const s = "a".repeat(300);
    const { text, truncatedChars } = truncateText(s, 280);
    expect(truncatedChars).toBe(20);
    expect(text).toBe(`${"a".repeat(280)}…⟨+20⟩`);
  });
  test("max 0 drops the body entirely but still counts it", () => {
    expect(truncateText("body text here", 0)).toEqual({ text: "", truncatedChars: 14 });
  });
  test("collapses whitespace to a single line", () => {
    expect(truncateText("a\n\n  b\tc", 280).text).toBe("a b c");
  });
  test("empty / non-string yields empty", () => {
    expect(truncateText("   ", 280)).toEqual({ text: "", truncatedChars: 0 });
    expect(truncateText(null, 280)).toEqual({ text: "", truncatedChars: 0 });
  });
});

describe("isBotActor", () => {
  test.each([
    ["greptile-bot", true],
    ["coderabbitai[bot]", true],
    ["dependabot[bot]", true],
    ["github-actions[bot]", true],
    ["sonarqubecloud[bot]", true],
    ["renovate[bot]", true],
    ["alice", false],
    ["robert", false],
    [undefined, false],
  ])("%s → %s", (login, expected) => {
    expect(isBotActor(login as string | undefined)).toBe(expected);
  });
});

describe("buildHookEssentials — github", () => {
  test("issue_comment: compact headline + facts + truncated body", () => {
    const body = "please rebase onto main, CI is red. " + "z".repeat(500);
    const e = buildHookEssentials("issue_comment", PR_COMMENT("alice", body));
    expect(e.source).toBe("github");
    expect(e.headline).toBe("org/repo#42 — Fix the flaky test");
    expect(e.facts).toContainEqual({ label: "author", value: "alice" });
    expect(e.body?.fromBot).toBe(false);
    expect(e.body?.text.length).toBeLessThanOrEqual(HOOK_LIMITS.freeText + 12);
    expect(e.body?.truncatedChars).toBeGreaterThan(0);
    expect(e.body?.text).toContain("please rebase onto main");
  });

  test("bot comment: body suppressed entirely (fromBot, empty text)", () => {
    const e = buildHookEssentials("issue_comment", PR_COMMENT("greptile-bot", "X".repeat(3000)));
    expect(e.body?.fromBot).toBe(true);
    expect(e.body?.text).toBe("");
    expect(e.body?.truncatedChars).toBe(3000);
  });

  test("pull_request_review surfaces the review state as a fact", () => {
    const e = buildHookEssentials("pull_request_review", {
      action: "submitted",
      repository: { full_name: "org/repo" },
      sender: { login: "bob" },
      pull_request: { number: 42, title: "T", html_url: "https://gh/pr/42" },
      review: { state: "changes_requested", body: "two nits" },
    });
    expect(e.facts).toContainEqual({ label: "review", value: "changes_requested" });
    expect(e.body?.text).toBe("two nits");
  });

  test("review-comment with path/line records an `at` fact", () => {
    const e = buildHookEssentials("pull_request_review_comment", {
      action: "created",
      repository: { full_name: "org/repo" },
      sender: { login: "alice" },
      pull_request: { number: 42, title: "T" },
      comment: { user: { login: "alice" }, body: "nit", path: "src/x.ts", line: 12 },
    });
    expect(e.facts).toContainEqual({ label: "at", value: "src/x.ts:12" });
  });
});

describe("buildHookEssentials — sentry/datadog (identity only, no stacktrace)", () => {
  test("sentry: project/level/culprit/count, never breadcrumbs", () => {
    const e = buildHookEssentials("sentry:issue", SENTRY_ISSUE);
    expect(e.source).toBe("sentry");
    expect(e.facts).toContainEqual({ label: "project", value: "clara-prod" });
    expect(e.facts).toContainEqual({ label: "level", value: "error" });
    expect(e.body).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain("breadcrumb");
  });
  test("datadog: priority/status/tags + truncated message body", () => {
    const e = buildHookEssentials("datadog:alert", DATADOG_ALERT);
    expect(e.source).toBe("datadog");
    expect(e.facts).toContainEqual({ label: "priority", value: "P1" });
    expect(e.body?.text).toBe("p99 > 2s");
  });
});

describe("renderHookSummaryMarkdown — compact output", () => {
  test("no legacy bullet boilerplate; one headline + one facts line", () => {
    const md = renderHookSummaryMarkdown("issue_comment", PR_COMMENT("alice", "hi there"));
    expect(md).not.toContain("**repo**");
    expect(md).not.toContain("**sender**");
    expect(md).not.toContain("**event**");
    expect(md).toContain("org/repo#42 — Fix the flaky test");
    expect(md).toContain("> hi there");
  });
  test("bot body renders the suppression note, not the text", () => {
    const md = renderHookSummaryMarkdown(
      "issue_comment",
      PR_COMMENT("greptile-bot", "huge review dump ".repeat(200)),
    );
    expect(md).toContain("(body suppressed");
    expect(md).not.toContain("huge review dump huge");
  });
});

describe("prefilterReason — bot-noise drop, recorded not prompted", () => {
  test("bot comment with no allowlist → bot-noise skip reason", () => {
    expect(prefilterReason("issue_comment", PR_COMMENT("greptile-bot", "x"))).toBe(
      "bot noise: greptile-bot",
    );
  });
  test("human comment is never prefiltered", () => {
    expect(prefilterReason("issue_comment", PR_COMMENT("alice", "x"))).toBeNull();
  });
  test("allowlisted bot (Greptile-as-trigger) is NOT prefiltered", () => {
    expect(prefilterReason("issue_comment", PR_COMMENT("greptile-bot", "x"), ["greptile-bot"])).toBeNull();
  });
  test("a bot excluded from the allowlist is still prefiltered", () => {
    expect(
      prefilterReason("issue_comment", PR_COMMENT("greptile-bot", "x"), ["*", "!*-bot"]),
    ).toBe("bot noise: greptile-bot");
  });
  test("non-comment events are never prefiltered", () => {
    expect(prefilterReason("pull_request", { sender: { login: "greptile-bot" } })).toBeNull();
  });
});
