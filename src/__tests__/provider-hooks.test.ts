import { describe, expect, test } from "bun:test";
import {
  extractHookScope,
  matchDatadogRule,
  matchSentryRule,
  readDatadogPayload,
  readSentryPayload,
  renderHookSummaryMarkdown,
} from "../hooks/match";
import { parseHookConfig } from "../hooks/schema";

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
  test("sentry: true → match-any", () => {
    expect(parseHookConfig({ sentry: true })?.sentry).toBe(true);
  });
  test("sentry object normalizes lists", () => {
    const cfg = parseHookConfig({ sentry: { project: "clara-*", level: ["error", "fatal"] } });
    expect(cfg?.sentry).toEqual({ project: ["clara-*"], level: ["error", "fatal"], action: [] });
  });
  test("datadog object normalizes lists", () => {
    const cfg = parseHookConfig({ datadog: { monitor: "789", priority: "P1" } });
    expect(cfg?.datadog).toEqual({ monitor: ["789"], priority: ["P1"], type: [], tags: [] });
  });
  test("prs + sentry combine", () => {
    const cfg = parseHookConfig({ prs: true, sentry: true });
    expect(cfg?.pr.length).toBe(1);
    expect(cfg?.sentry).toBe(true);
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
  test("scope prefers aggreg_key", () => {
    expect(extractHookScope("datadog:alert", DATADOG_ALERT)).toBe("dd-cycle-abc");
  });
  test("scope falls back to monitor", () => {
    const noAgg = { ...DATADOG_ALERT, aggreg_key: undefined };
    expect(extractHookScope("datadog:alert", noAgg)).toBe("dd-monitor-789");
  });
});
