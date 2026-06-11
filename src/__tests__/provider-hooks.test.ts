import { describe, expect, test } from "bun:test";
import {
  buildHookTrigger,
  evalLinearRule,
  extractHookLabel,
  extractHookScope,
  linearRuleSkipReason,
  matchDatadogRule,
  matchLinearRule,
  matchSentryRule,
  readDatadogPayload,
  readLinearPayload,
  readSentryPayload,
  renderHookSummaryMarkdown,
  sentryRuleSkipReason,
} from "../hooks/match";
import {
  buildHookEssentials,
  HOOK_LIMITS,
  isBotActor,
  prefilterReason,
  truncateRichText,
  truncateText,
} from "../../shared/hookEssentials";
import {
  parseTriggers,
  defaultLinearRule,
  defaultSentryRule,
  defaultDatadogRule,
  DEFAULT_DATADOG_PRIORITY_PATTERNS,
  DEFAULT_LINEAR_TYPES,
  ERROR_SENTRY_RESOURCES,
  PROD_SENTRY_ENV_PATTERNS,
} from "../hooks/schema";

const SENTRY_ISSUE = {
  action: "created",
  data: {
    issue: {
      id: "55",
      shortId: "CLARA-BACKEND-T1",
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

// Real ERROR webhook shape: env + a `[key, value][]` tags array carrying the
// host under the `server_name` tag. No shortId on error events.
const SENTRY_ERROR = {
  action: "created",
  data: {
    error: {
      title: "ValueError: bad input",
      level: "error",
      environment: "production",
      project: "clara-backend",
      tags: [
        ["level", "error"],
        ["server_name", "d8d9e3ec602738"],
      ],
    },
  },
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
  test("sentry: true → errors-only, any project, prod-env default (not match-any)", () => {
    expect(parseTriggers([{ sentry: true }], undefined).hookConfig?.sentry).toEqual(
      defaultSentryRule(),
    );
    expect(defaultSentryRule().resource).toEqual(ERROR_SENTRY_RESOURCES);
    expect(defaultSentryRule().project).toEqual(["*"]);
    expect(defaultSentryRule().environment).toEqual(PROD_SENTRY_ENV_PATTERNS);
  });
  test("sentry object without environment → errors-only + prod-env default", () => {
    const cfg = parseTriggers([{ sentry: { level: ["error"] } }], undefined).hookConfig;
    expect(cfg?.sentry).toEqual({
      resource: [...ERROR_SENTRY_RESOURCES],
      project: ["*"],
      environment: [...PROD_SENTRY_ENV_PATTERNS],
      level: ["error"],
      action: [],
      host: [],
      firstSeen: false,
      debounceMs: 0,
    });
  });
  test("sentry object normalizes lists (explicit project, default resource/env)", () => {
    const cfg = parseTriggers(
      [{ sentry: { project: "clara-*", level: ["error", "fatal"] } }],
      undefined,
    ).hookConfig;
    expect(cfg?.sentry).toEqual({
      resource: [...ERROR_SENTRY_RESOURCES],
      project: ["clara-*"],
      environment: [...PROD_SENTRY_ENV_PATTERNS],
      level: ["error", "fatal"],
      action: [],
      host: [],
      firstSeen: false,
      debounceMs: 0,
    });
  });
  test("sentry environment: ['*'] opts back into all environments", () => {
    const cfg = parseTriggers([{ sentry: { environment: ["*"] } }], undefined).hookConfig;
    expect(cfg?.sentry).toEqual({
      resource: [...ERROR_SENTRY_RESOURCES],
      project: ["*"],
      environment: ["*"],
      level: [],
      action: [],
      host: [],
      firstSeen: false,
      debounceMs: 0,
    });
  });
  test("sentry resource: ['*'] opts into all webhook types", () => {
    const cfg = parseTriggers([{ sentry: { resource: ["*"] } }], undefined).hookConfig;
    expect((cfg?.sentry as { resource: string[] }).resource).toEqual(["*"]);
  });
  test("sentry firstSeen + debounceMs default off, parse when set", () => {
    const off = parseTriggers([{ sentry: true }], undefined).hookConfig?.sentry as {
      firstSeen: boolean;
      debounceMs: number;
    };
    expect(off.firstSeen).toBe(false);
    expect(off.debounceMs).toBe(0);

    const on = parseTriggers(
      [{ sentry: { firstSeen: true, debounceMs: 5000 } }],
      undefined,
    ).hookConfig?.sentry as { firstSeen: boolean; debounceMs: number };
    expect(on.firstSeen).toBe(true);
    expect(on.debounceMs).toBe(5000);
  });
  test("sentry debounceMs coerces a numeric string, rejects junk/negatives", () => {
    const num = parseTriggers([{ sentry: { debounceMs: "2500" } }], undefined).hookConfig
      ?.sentry as { debounceMs: number };
    expect(num.debounceMs).toBe(2500);
    const junk = parseTriggers([{ sentry: { debounceMs: -1 } }], undefined).hookConfig?.sentry as {
      debounceMs: number;
    };
    expect(junk.debounceMs).toBe(0);
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
    expect(matchSentryRule({ resource: [], project: ["clara-*"], environment: [], level: [], action: [], host: [] }, p)).toBe(true);
  });
  test("level filter excludes", () => {
    const p = readSentryPayload(SENTRY_ISSUE)!;
    expect(matchSentryRule({ resource: [], project: ["*"], environment: [], level: ["fatal"], action: [], host: [] }, p)).toBe(false);
    expect(matchSentryRule({ resource: [], project: ["*"], environment: [], level: ["error"], action: [], host: [] }, p)).toBe(true);
  });
  test("action filter", () => {
    const p = readSentryPayload(SENTRY_ISSUE)!;
    expect(matchSentryRule({ resource: [], project: ["*"], environment: [], level: [], action: ["resolved"], host: [] }, p)).toBe(false);
    expect(matchSentryRule({ resource: [], project: ["*"], environment: [], level: [], action: ["created"], host: [] }, p)).toBe(true);
  });
  test("prod default matches prod ENVIRONMENTS (any project), rejects staging+dev", () => {
    const rule = defaultSentryRule();
    const at = (environment: string) =>
      readSentryPayload({ action: "created", data: { event: { project: "clara-backend", environment } } })!;
    for (const env of ["prod", "clara-prod", "prod-api", "production"]) {
      expect(matchSentryRule(rule, at(env))).toBe(true);
    }
    for (const env of ["staging", "dev", "preprod"]) {
      expect(matchSentryRule(rule, at(env))).toBe(false);
    }
    // …and it no longer keys off the project slug: a non-prod-named project on a
    // prod environment still matches (the old project-glob default would miss it).
    expect(matchSentryRule(rule, at("production"))).toBe(true);
  });
  test("environment filter is LENIENT: an event with NO environment still matches", () => {
    const rule = defaultSentryRule(); // environment: prod patterns
    // Real Sentry ISSUE webhooks carry no environment — must not be dropped.
    const issueNoEnv = readSentryPayload({
      action: "created",
      data: { issue: { id: "1", level: "error", project: { slug: "clara-backend" } } },
    })!;
    expect(issueNoEnv.environment).toBe("");
    expect(matchSentryRule(rule, issueNoEnv)).toBe(true);
    // …but an event that DOES report a non-prod environment is still rejected.
    const stagingEvent = readSentryPayload({
      action: "created",
      data: { event: { project: "clara-backend", environment: "staging" } },
    })!;
    expect(matchSentryRule(rule, stagingEvent)).toBe(false);
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

describe("sentry host filter", () => {
  test("server_name is read from the top-level field or the tags array", () => {
    expect(readSentryPayload(SENTRY_ERROR)!.serverName).toBe("d8d9e3ec602738");
    // Top-level data.error.server_name wins over the tag.
    const topLevel = readSentryPayload({
      action: "created",
      data: { error: { server_name: "host-a", tags: [["server_name", "host-b"]] } },
    })!;
    expect(topLevel.serverName).toBe("host-a");
    // Issue webhooks carry no host.
    expect(readSentryPayload(SENTRY_ISSUE)!.serverName).toBe("");
  });
  test("host present + matching → ok", () => {
    const p = readSentryPayload(SENTRY_ERROR)!;
    const rule = { ...defaultSentryRule(), host: ["d8d9e3ec*"] };
    expect(matchSentryRule(rule, p)).toBe(true);
  });
  test("host present + mismatched → rejected with reason", () => {
    const p = readSentryPayload(SENTRY_ERROR)!;
    const rule = { ...defaultSentryRule(), host: ["other-host-*"] };
    expect(matchSentryRule(rule, p)).toBe(false);
    expect(sentryRuleSkipReason(rule, p)).toContain("host");
    expect(sentryRuleSkipReason(rule, p)).toContain("d8d9e3ec602738");
  });
  test("host absent → LENIENT pass (issue webhooks carry no host)", () => {
    const p = readSentryPayload(SENTRY_ISSUE)!;
    expect(p.serverName).toBe("");
    const rule = { ...defaultSentryRule(), host: ["only-this-host"] };
    expect(matchSentryRule(rule, p)).toBe(true);
  });
  test("host globs: wildcard include + negated exclude", () => {
    const staging = readSentryPayload({
      action: "created",
      data: { error: { environment: "production", tags: [["server_name", "web-staging-01"]] } },
    })!;
    const prod = readSentryPayload({
      action: "created",
      data: { error: { environment: "production", tags: [["server_name", "web-prod-01"]] } },
    })!;
    // `*-staging-*` includes only staging hosts.
    expect(matchSentryRule({ ...defaultSentryRule(), host: ["*-staging-*"] }, staging)).toBe(true);
    expect(matchSentryRule({ ...defaultSentryRule(), host: ["*-staging-*"] }, prod)).toBe(false);
    // `["*", "!*-staging-*"]` allows everything except staging.
    const exceptStaging = { ...defaultSentryRule(), host: ["*", "!*-staging-*"] };
    expect(matchSentryRule(exceptStaging, prod)).toBe(true);
    expect(matchSentryRule(exceptStaging, staging)).toBe(false);
  });
});

describe("sentry shortId label", () => {
  test("issue webhook → shortId is the label", () => {
    expect(extractHookLabel("sentry:issue", SENTRY_ISSUE)).toBe("CLARA-BACKEND-T1");
  });
  test("error event (no shortId) → project/title fallback", () => {
    expect(extractHookLabel("sentry:error", SENTRY_ERROR)).toBe(
      "clara-backend: ValueError: bad input",
    );
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

describe("truncateRichText — multi-line, structure-preserving", () => {
  test("preserves newlines, code fences, lists, and headings", () => {
    const body = [
      "## Heading",
      "",
      "Some prose with a list:",
      "- one",
      "- two",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(truncateRichText(body, HOOK_LIMITS.richBody)).toBe(body);
  });
  test("normalizes CRLF and trims outer edges but keeps interior blanks", () => {
    expect(truncateRichText("\r\n\r\na\r\n\r\nb\r\n  ", HOOK_LIMITS.richBody)).toBe("a\n\nb");
  });
  test("over the cap appends a … [truncated, N chars total] tail on its own line", () => {
    const body = "x".repeat(5000);
    const out = truncateRichText(body, HOOK_LIMITS.richBody);
    expect(out.startsWith("x".repeat(HOOK_LIMITS.richBody))).toBe(true);
    expect(out).toContain("… [truncated, 5000 chars total]");
    // The tail sits on its own paragraph so it can't land inside a code fence.
    expect(out).toContain("\n\n… [truncated");
  });
  test("empty / non-string yields empty", () => {
    expect(truncateRichText("   ", HOOK_LIMITS.richBody)).toBe("");
    expect(truncateRichText(null, HOOK_LIMITS.richBody)).toBe("");
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

  test("bot comment: body kept but truncated (fromBot, longer limit, source link)", () => {
    const e = buildHookEssentials("issue_comment", PR_COMMENT("greptile-bot", "X".repeat(3000)));
    expect(e.body?.fromBot).toBe(true);
    // Bot bodies ARE meaningful (e.g. a Greptile review) — kept, just truncated
    // to the longer bot limit, not dropped to "".
    expect(e.body?.text.length).toBeGreaterThan(0);
    expect(e.body?.text.length).toBeLessThanOrEqual(HOOK_LIMITS.botFreeText + 12);
    expect(e.body?.truncatedChars).toBeGreaterThan(0);
    // The trigger links to the SPECIFIC comment (its html_url), not the PR.
    expect(e.url).toBe("https://gh/c/1");
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
  test("bot body is kept (truncated), with a source link to the comment", () => {
    const md = renderHookSummaryMarkdown(
      "issue_comment",
      PR_COMMENT("greptile-bot", "huge review dump ".repeat(200)),
    );
    // Body content is shown, not dropped — the meaningful part of a bot review.
    expect(md).toContain("> huge review dump huge");
    expect(md).not.toContain("(body suppressed");
    // Linkified headline points at the comment's own url (the source).
    expect(md).toContain("(https://gh/c/1)");
  });

  test("multi-paragraph body with a code fence survives to markdown output", () => {
    const body = [
      "Here is the repro:",
      "",
      "```ts",
      "expect(foo()).toBe(1);",
      "```",
      "",
      "- it fails on CI",
      "- passes locally",
    ].join("\n");
    const md = renderHookSummaryMarkdown("issue_comment", PR_COMMENT("alice", body));
    // Every body line is `> `-prefixed (blockquote) so structure + the nested
    // fence survive — newlines are NOT collapsed into one line anymore.
    expect(md).toContain("> ```ts");
    expect(md).toContain("> expect(foo()).toBe(1);");
    expect(md).toContain("> - it fails on CI");
    expect(md).toContain("> - passes locally");
    // Blank lines inside the quote stay contiguous as a bare ">".
    expect(md).toContain("\n>\n");
  });

  test("an enormous body is capped with a truncation tail (not 280 chars)", () => {
    const body = `start of comment\n\n${"y".repeat(6000)}`;
    const e = buildHookEssentials("issue_comment", PR_COMMENT("alice", body));
    // The rich body keeps WAY more than the old 280-char one-line cap.
    expect(e.body?.richText.length).toBeGreaterThan(1000);
    expect(e.body?.richText.length).toBeLessThanOrEqual(HOOK_LIMITS.richBody + 64);
    const md = renderHookSummaryMarkdown("issue_comment", PR_COMMENT("alice", body));
    expect(md).toContain("chars total]");
    expect(md).toContain("> start of comment");
  });

  test("a block-HTML body (Greptile collapsible) is emitted RAW, not blockquoted", () => {
    // Block HTML doesn't parse inside a markdown blockquote, so the renderer needs
    // it un-quoted (rehype-raw parses it). `> <details>` would render as literal text.
    const body = "<details><summary><h3>Greptile Summary</h3></summary>\n\nLGTM\n</details>";
    const md = renderHookSummaryMarkdown("issue_comment", PR_COMMENT("greptile-bot", body));
    expect(md).toContain("<details><summary><h3>Greptile Summary</h3></summary>");
    // No `> ` prefix on the HTML — it is raw so it parses.
    expect(md).not.toContain("> <details>");
  });

  test("a plain/markdown body (with a code fence) stays blockquoted", () => {
    // Regression guard: the HTML detection must NOT trip on plain markdown — a fenced
    // code block still gets the `> ` wrapper so the fence can't escape.
    const body = ["look:", "", "```sh", "make build", "```"].join("\n");
    const md = renderHookSummaryMarkdown("issue_comment", PR_COMMENT("alice", body));
    expect(md).toContain("> ```sh");
    expect(md).toContain("> make build");
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

describe("linear schema + matching", () => {
  const ISSUE = {
    type: "Issue",
    action: "create",
    data: { identifier: "CLA-1200", title: "x", team: { key: "CLA" }, description: "hey @clawd" },
  };

  test("linear: true → @mentioned Issue/Comment, any team default", () => {
    const cfg = parseTriggers([{ linear: true }], undefined).hookConfig;
    expect(cfg?.linear).toEqual(defaultLinearRule());
    expect(defaultLinearRule().type).toEqual(DEFAULT_LINEAR_TYPES);
    expect(defaultLinearRule().mention).toBe(true);
  });

  test("explicit rule normalizes; mention defaults on, type defaults to Issue/Comment", () => {
    const cfg = parseTriggers([{ linear: { team: "CLA" } }], undefined).hookConfig;
    expect(cfg?.linear).toEqual({
      type: ["Issue", "Comment"],
      team: ["CLA"],
      action: [],
      priority: [],
      state: [],
      labels: [],
      mention: true,
    });
  });

  test("mention gate: un-mentioned event is skipped, mentioned matches", () => {
    const p = readLinearPayload(ISSUE);
    p.mentioned = false;
    expect(matchLinearRule(defaultLinearRule(), p)).toBe(false);
    expect(linearRuleSkipReason(defaultLinearRule(), p)).toContain("@mention");
    p.mentioned = true;
    expect(matchLinearRule(defaultLinearRule(), p)).toBe(true);
  });

  test("mention: false fires without an @mention", () => {
    const p = readLinearPayload(ISSUE);
    p.mentioned = false;
    const rule = { ...defaultLinearRule(), mention: false };
    expect(matchLinearRule(rule, p)).toBe(true);
  });

  test("type filter (case-insensitive) + team filter", () => {
    const reaction = readLinearPayload({ type: "Reaction", action: "create", data: {} });
    reaction.mentioned = true;
    expect(matchLinearRule(defaultLinearRule(), reaction)).toBe(false);

    const p = readLinearPayload(ISSUE);
    p.mentioned = true;
    expect(
      matchLinearRule(
        { type: ["issue"], team: [], action: [], priority: [], state: [], labels: [], mention: true },
        p,
      ),
    ).toBe(true);
    expect(
      matchLinearRule(
        { type: [], team: ["ENG"], action: [], priority: [], state: [], labels: [], mention: true },
        p,
      ),
    ).toBe(false);
    expect(
      matchLinearRule(
        { type: [], team: ["CLA"], action: [], priority: [], state: [], labels: [], mention: true },
        p,
      ),
    ).toBe(true);
  });

  test("readLinearPayload reads identifier/team from a Comment's parent issue", () => {
    const comment = readLinearPayload({
      type: "Comment",
      action: "create",
      data: { body: "ping @clawd", issue: { identifier: "ENG-9", title: "T", team: { key: "ENG" } } },
    });
    expect(comment.identifier).toBe("ENG-9");
    expect(comment.team).toBe("ENG");
    expect(comment.type).toBe("Comment");
  });

  // A realistic Issue.create webhook with the full data shape.
  const ISSUE_FULL = {
    type: "Issue",
    action: "create",
    url: "https://linear.app/clara/issue/ENG-42/fix-the-thing",
    data: {
      identifier: "ENG-42",
      title: "Fix the thing",
      team: { key: "ENG" },
      state: { name: "In Progress" },
      priority: 1,
      assignee: { name: "Ada" },
      creator: { name: "Grace" },
      labels: [{ name: "bug" }, { name: "p0" }],
      url: "https://linear.app/clara/issue/ENG-42/fix-the-thing",
      description: "hey @clawd take a look",
    },
  };

  test("readLinearPayload extracts state/priority(+label)/assignee/creator/labels/url", () => {
    const p = readLinearPayload(ISSUE_FULL);
    expect(p.state).toBe("In Progress");
    expect(p.priority).toBe(1);
    expect(p.priorityLabel).toBe("Urgent");
    expect(p.assignee).toBe("Ada");
    expect(p.creator).toBe("Grace");
    expect(p.labels).toEqual(["bug", "p0"]);
    expect(p.url).toBe("https://linear.app/clara/issue/ENG-42/fix-the-thing");
  });

  test("priority maps 0-4 -> None/Urgent/High/Normal/Low; absent -> -1 / empty label", () => {
    const at = (priority: number) => readLinearPayload({ type: "Issue", data: { priority } });
    expect(at(0).priorityLabel).toBe("None");
    expect(at(2).priorityLabel).toBe("High");
    expect(at(3).priorityLabel).toBe("Normal");
    expect(at(4).priorityLabel).toBe("Low");
    const none = readLinearPayload({ type: "Issue", data: {} });
    expect(none.priority).toBe(-1);
    expect(none.priorityLabel).toBe("");
  });

  test("priority gate is LENIENT: present-mismatch rejects, absent passes", () => {
    const rule = { ...defaultLinearRule(), priority: ["Urgent", "High"] };
    const urgent = readLinearPayload(ISSUE_FULL); // priority 1 -> Urgent
    urgent.mentioned = true;
    expect(matchLinearRule(rule, urgent)).toBe(true);
    const low = readLinearPayload({ type: "Issue", data: { priority: 4 } });
    low.mentioned = true;
    expect(matchLinearRule(rule, low)).toBe(false);
    expect(linearRuleSkipReason(rule, low)).toContain("priority");
    // Absent priority -> lenient pass.
    const noprio = readLinearPayload({ type: "Issue", data: {} });
    noprio.mentioned = true;
    expect(matchLinearRule(rule, noprio)).toBe(true);
  });

  test("state gate is LENIENT: present-mismatch rejects, absent passes", () => {
    const rule = { ...defaultLinearRule(), state: ["In Progress", "Todo"] };
    const inprog = readLinearPayload(ISSUE_FULL);
    inprog.mentioned = true;
    expect(matchLinearRule(rule, inprog)).toBe(true);
    const done = readLinearPayload({ type: "Issue", data: { state: { name: "Done" } } });
    done.mentioned = true;
    expect(matchLinearRule(rule, done)).toBe(false);
    expect(linearRuleSkipReason(rule, done)).toContain("state");
    const nostate = readLinearPayload({ type: "Issue", data: {} });
    nostate.mentioned = true;
    expect(matchLinearRule(rule, nostate)).toBe(true);
  });

  test("labels use include/exclude set-membership semantics", () => {
    const p = readLinearPayload(ISSUE_FULL); // labels: bug, p0
    p.mentioned = true;
    // required label present
    expect(matchLinearRule({ ...defaultLinearRule(), labels: ["bug"] }, p)).toBe(true);
    // required label absent
    expect(matchLinearRule({ ...defaultLinearRule(), labels: ["wontfix"] }, p)).toBe(false);
    // excluded label present
    expect(matchLinearRule({ ...defaultLinearRule(), labels: ["!p0"] }, p)).toBe(false);
    // empty = no constraint
    expect(matchLinearRule({ ...defaultLinearRule(), labels: [] }, p)).toBe(true);
  });

  test("evalLinearRule mention gate unchanged with the new fields present", () => {
    const p = readLinearPayload(ISSUE_FULL);
    p.mentioned = false;
    expect(evalLinearRule(defaultLinearRule(), p).reason).toContain("@mention");
    p.mentioned = true;
    expect(evalLinearRule(defaultLinearRule(), p).ok).toBe(true);
  });

  test("buildHookTrigger linear branch -> action + `ID (TEAM)` repo", () => {
    const t = buildHookTrigger("linear:issue.create", ISSUE_FULL);
    expect(t.event).toBe("linear:issue.create");
    expect(t.action).toBe("create");
    expect(t.repo).toBe("ENG-42 (ENG)");
  });

  test("buildHookTrigger linear falls back to team when no identifier", () => {
    const t = buildHookTrigger("linear:comment.create", {
      type: "Comment",
      action: "create",
      data: { team: { key: "ENG" } },
    });
    expect(t.repo).toBe("ENG");
  });
});
