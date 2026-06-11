import { describe, expect, test } from "bun:test";
// The web mirror MUST agree with the backend schema — import both and assert.
import * as webMirror from "../../web/ui/hookConfig";
import { readFrontmatter, writeFrontmatter } from "../../web/ui/schedule";
import {
  defaultGitHubTriggers,
  defaultLinearRule,
  type GitHubTriggers,
  gitHubTriggersToHookConfig,
  type HookConfig,
  hookConfigToGitHubTriggers,
  summarizeGitHubTriggers,
} from "../hooks/schema";

/** Build a matrix from the 4 booleans + defaults, for terse cases. */
function matrix(
  hPr: boolean,
  hC: boolean,
  bPr: boolean,
  bC: boolean,
  over: Partial<GitHubTriggers> = {},
): GitHubTriggers {
  return {
    humans: { prUpdates: hPr, comments: hC },
    bots: { prUpdates: bPr, comments: bC },
    advanced: { base: ["!main"], labels: [], draft: false, repo: ["*/*"] },
    skipSelf: true,
    ...over,
  };
}

describe("gitHubTriggersToHookConfig — matrix → HookConfig", () => {
  test("easy defaults: humans PR+comments, bots off", () => {
    const cfg = gitHubTriggersToHookConfig(defaultGitHubTriggers());
    expect(cfg).not.toBeNull();
    expect(cfg?.pr).toEqual([
      {
        repo: "*/*",
        user: ["*", "!*[bot]"],
        action: ["opened", "synchronize", "reopened"],
        branch: ["!main"],
        labels: [],
        draft: false,
      },
    ]);
    expect(cfg?.comments).toEqual({ user: ["*", "!*[bot]"] });
    expect(cfg?.skipSelf).toBe(true);
  });

  test("both classes checked → a single `*` rule + comments true", () => {
    const cfg = gitHubTriggersToHookConfig(matrix(true, true, true, true));
    expect(cfg?.pr).toHaveLength(1);
    expect(cfg?.pr[0]?.user).toEqual(["*"]);
    expect(cfg?.comments).toBe(true);
  });

  test("bots-only PR updates → `*[bot]` glob, no comments", () => {
    const cfg = gitHubTriggersToHookConfig(matrix(false, false, true, false));
    expect(cfg?.pr[0]?.user).toEqual(["*[bot]"]);
    expect(cfg?.comments).toBeUndefined();
  });

  test("everything off → null (drop the on: block)", () => {
    expect(gitHubTriggersToHookConfig(matrix(false, false, false, false))).toBeNull();
  });

  test("skipSelf false is carried verbatim", () => {
    const cfg = gitHubTriggersToHookConfig(matrix(true, false, false, false, { skipSelf: false }));
    expect(cfg?.skipSelf).toBe(false);
  });
});

describe("round-trip stability: matrix → config → matrix", () => {
  // Every 2×2 combination of the 4 checkboxes.
  for (let bits = 0; bits < 16; bits++) {
    const hPr = !!(bits & 1);
    const hC = !!(bits & 2);
    const bPr = !!(bits & 4);
    const bC = !!(bits & 8);
    test(`combo h.pr=${hPr} h.c=${hC} b.pr=${bPr} b.c=${bC}`, () => {
      const m = matrix(hPr, hC, bPr, bC);
      const cfg = gitHubTriggersToHookConfig(m);
      const { matrix: back, representable } = hookConfigToGitHubTriggers(cfg);
      expect(representable).toBe(true);
      expect(back.humans).toEqual(m.humans);
      expect(back.bots).toEqual(m.bots);
      expect(back.skipSelf).toBe(m.skipSelf);
      // Advanced survives only when a PR rule exists to carry it; with no PR
      // row the projection legitimately resets to defaults.
      if (hPr || bPr) expect(back.advanced).toEqual(m.advanced);
    });
  }

  test("advanced fields survive the round-trip when a PR rule exists", () => {
    const m = matrix(true, false, false, false, {
      advanced: { base: ["release/*", "!main"], labels: ["ready"], draft: "any", repo: ["me/*"] },
    });
    const cfg = gitHubTriggersToHookConfig(m);
    const { matrix: back, representable } = hookConfigToGitHubTriggers(cfg);
    expect(representable).toBe(true);
    expect(back.advanced).toEqual(m.advanced);
  });
});

describe("hookConfigToGitHubTriggers — representability", () => {
  test("null config → empty matrix, representable", () => {
    const { matrix: m, representable } = hookConfigToGitHubTriggers(null);
    expect(representable).toBe(true);
    expect(m.humans).toEqual({ prUpdates: false, comments: false });
    expect(m.bots).toEqual({ prUpdates: false, comments: false });
  });

  test("two PR rules → NOT representable", () => {
    const cfg: HookConfig = {
      pr: [
        {
          repo: "a/b",
          user: ["*"],
          action: ["opened", "synchronize", "reopened"],
          branch: ["*"],
          labels: [],
          draft: false,
        },
        {
          repo: "c/d",
          user: ["*"],
          action: ["opened", "synchronize", "reopened"],
          branch: ["*"],
          labels: [],
          draft: false,
        },
      ],
      skipSelf: true,
    };
    expect(hookConfigToGitHubTriggers(cfg).representable).toBe(false);
  });

  test("non-default action set → NOT representable", () => {
    const cfg: HookConfig = {
      pr: [
        { repo: "*/*", user: ["*"], action: ["closed"], branch: ["*"], labels: [], draft: false },
      ],
      skipSelf: true,
    };
    expect(hookConfigToGitHubTriggers(cfg).representable).toBe(false);
  });

  test("default action set, order-insensitive → representable", () => {
    const cfg: HookConfig = {
      pr: [
        {
          repo: "*/*",
          user: ["*"],
          action: ["reopened", "opened", "synchronize"],
          branch: ["*"],
          labels: [],
          draft: false,
        },
      ],
      skipSelf: true,
    };
    expect(hookConfigToGitHubTriggers(cfg).representable).toBe(true);
  });

  test("bespoke user glob → NOT representable", () => {
    const cfg: HookConfig = {
      pr: [
        {
          repo: "*/*",
          user: ["alice", "!bob"],
          action: ["opened", "synchronize", "reopened"],
          branch: ["*"],
          labels: [],
          draft: false,
        },
      ],
      skipSelf: true,
    };
    expect(hookConfigToGitHubTriggers(cfg).representable).toBe(false);
  });

  test("comment filter that isn't a class glob → NOT representable", () => {
    const cfg: HookConfig = { pr: [], comments: { user: ["specific-bot"] }, skipSelf: true };
    expect(hookConfigToGitHubTriggers(cfg).representable).toBe(false);
  });

  test("sentry/datadog present → NOT representable", () => {
    const cfg: HookConfig = { pr: [], comments: true, sentry: true, skipSelf: true };
    expect(hookConfigToGitHubTriggers(cfg).representable).toBe(false);
  });
});

describe("frontmatter round-trip through the .md `on:` block", () => {
  const SEED = `---
model: opus
effort: high
on:
  - schedule: "0 9 * * *"
---
Routine body stays put.
`;

  // matrix → config → writeFrontmatter → readFrontmatter → config → matrix
  for (let bits = 0; bits < 16; bits++) {
    const hPr = !!(bits & 1);
    const hC = !!(bits & 2);
    const bPr = !!(bits & 4);
    const bC = !!(bits & 8);
    test(`yaml stable for h.pr=${hPr} h.c=${hC} b.pr=${bPr} b.c=${bC}`, () => {
      const m = matrix(hPr, hC, bPr, bC);
      const cfg = gitHubTriggersToHookConfig(m);
      const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
      // unrelated keys + body preserved
      expect(written).toContain("model: opus");
      expect(written).toContain("Routine body stays put.");

      const read = readFrontmatter(written);
      const { matrix: back, representable } = hookConfigToGitHubTriggers(read.hookConfig);
      expect(representable).toBe(true);
      expect(back.humans).toEqual(m.humans);
      expect(back.bots).toEqual(m.bots);
    });
  }

  test("easy defaults serialize to the spec's `on:` block (pr + comments)", () => {
    const cfg = gitHubTriggersToHookConfig(defaultGitHubTriggers());
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).toContain("user");
    expect(written).toMatch(/pr:/);
    expect(written).toMatch(/comments:/);
    // skip_self is the default → omitted.
    expect(written).not.toContain("skip_self");
  });

  test("skip_self: false is emitted when disabled", () => {
    const m = matrix(true, false, false, false, { skipSelf: false });
    const cfg = gitHubTriggersToHookConfig(m);
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).toContain("skip_self: false");
  });
});

describe("checks / issues frontmatter round-trip (exact, no lossy collapse)", () => {
  const SEED = `---
model: opus
on:
  - schedule: "0 9 * * *"
---
Body.
`;
  /** writeFrontmatter → readFrontmatter, returning the re-parsed hookConfig. */
  function roundTrip(cfg: HookConfig): HookConfig | null {
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    return readFrontmatter(written).hookConfig;
  }

  test("checks bad-CI default collapses to `checks: true` and re-parses identically", () => {
    const cfg: HookConfig = {
      pr: [],
      checks: { conclusion: ["failure", "timed_out", "cancelled"], branch: [], name: [] },
      skipSelf: true,
    };
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).toContain("checks: true");
    expect(roundTrip(cfg)?.checks).toEqual(cfg.checks);
  });

  test("checks conclusion: ['*'] does NOT collapse to true (would re-narrow to bad-CI)", () => {
    const cfg: HookConfig = {
      pr: [],
      checks: { conclusion: ["*"], branch: ["main"], name: ["build"] },
      skipSelf: true,
    };
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).not.toMatch(/checks:\s*true/);
    expect(roundTrip(cfg)?.checks).toEqual(cfg.checks);
  });

  test("checks 'any conclusion' ([]) survives the round-trip (not dropped to default)", () => {
    const cfg: HookConfig = {
      pr: [],
      checks: { conclusion: [], branch: [], name: [] },
      skipSelf: true,
    };
    // Empty conclusion = fire on ANY result — must NOT re-parse to the bad-CI default.
    expect(roundTrip(cfg)?.checks).toEqual({ conclusion: [], branch: [], name: [] });
  });

  test("issues opened-only default collapses to `issues: true`", () => {
    const cfg: HookConfig = { pr: [], issues: { action: ["opened"], label: [] }, skipSelf: true };
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).toContain("issues: true");
    expect(roundTrip(cfg)?.issues).toEqual(cfg.issues);
  });

  test("issues with explicit action/label round-trips exactly", () => {
    const cfg: HookConfig = {
      pr: [],
      issues: { action: ["labeled", "opened"], label: ["bug", "!wontfix"] },
      skipSelf: true,
    };
    expect(roundTrip(cfg)?.issues).toEqual(cfg.issues);
  });

  test("issues 'any action' ([]) survives the round-trip", () => {
    const cfg: HookConfig = { pr: [], issues: { action: [], label: [] }, skipSelf: true };
    expect(roundTrip(cfg)?.issues).toEqual({ action: [], label: [] });
  });
});

describe("linear frontmatter round-trip (exact, no lossy collapse)", () => {
  const SEED = `---
model: opus
on:
  - schedule: "0 9 * * *"
---
Body.
`;
  function roundTrip(cfg: HookConfig): HookConfig | null {
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    return readFrontmatter(written).hookConfig;
  }

  test("default rule collapses to `linear: true` and re-parses identically", () => {
    const cfg: HookConfig = { pr: [], linear: defaultLinearRule(), skipSelf: true };
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).toContain("linear: true");
    expect(roundTrip(cfg)?.linear).toEqual(defaultLinearRule());
  });

  test("boolean `linear: true` round-trips to the default rule", () => {
    const cfg: HookConfig = { pr: [], linear: true, skipSelf: true };
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).toContain("linear: true");
    expect(roundTrip(cfg)?.linear).toEqual(defaultLinearRule());
  });

  test("explicit 'any type' ([]) survives — does NOT collapse + re-narrow to [Issue,Comment]", () => {
    const cfg: HookConfig = {
      pr: [],
      linear: { type: [], team: [], action: [], priority: [], state: [], labels: [], mention: true },
      skipSelf: true,
    };
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).not.toMatch(/linear:\s*true/);
    expect(roundTrip(cfg)?.linear).toEqual({
      type: [],
      team: [],
      action: [],
      priority: [],
      state: [],
      labels: [],
      mention: true,
    });
  });

  test("full rule round-trips exactly", () => {
    const cfg: HookConfig = {
      pr: [],
      linear: {
        type: ["Issue"],
        team: ["ENG", "CLA-*"],
        action: ["create", "update"],
        priority: ["Urgent", "High"],
        state: ["In Progress"],
        labels: ["bug", "!wontfix"],
        mention: false,
      },
      skipSelf: true,
    };
    expect(roundTrip(cfg)?.linear).toEqual(cfg.linear);
  });

  test("partial rule (team only) round-trips exactly", () => {
    const cfg: HookConfig = {
      pr: [],
      linear: { type: ["Issue", "Comment"], team: ["ENG"], action: [], priority: [], state: [], labels: [], mention: true },
      skipSelf: true,
    };
    expect(roundTrip(cfg)?.linear).toEqual(cfg.linear);
  });

  test("mention:false alone round-trips (the safety gate is preserved)", () => {
    const cfg: HookConfig = {
      pr: [],
      linear: { type: ["Issue", "Comment"], team: [], action: [], priority: [], state: [], labels: [], mention: false },
      skipSelf: true,
    };
    const written = writeFrontmatter(SEED, { schedules: [], hookConfig: cfg });
    expect(written).toContain("mention: false");
    expect(roundTrip(cfg)?.linear).toEqual(cfg.linear);
  });
});

describe("web mirror agrees with the backend schema", () => {
  const cases: GitHubTriggers[] = [
    defaultGitHubTriggers(),
    matrix(true, true, true, true),
    matrix(false, false, true, false),
    matrix(true, false, false, true, { skipSelf: false }),
  ];
  test("gitHubTriggersToHookConfig identical across both copies", () => {
    for (const m of cases) {
      expect(webMirror.gitHubTriggersToHookConfig(m as never)).toEqual(
        gitHubTriggersToHookConfig(m) as never,
      );
    }
  });
  test("summarizeGitHubTriggers identical across both copies", () => {
    for (const m of cases) {
      expect(webMirror.summarizeGitHubTriggers(m as never)).toBe(summarizeGitHubTriggers(m));
    }
  });
});

describe("summarizeGitHubTriggers", () => {
  test("humans both categories", () => {
    expect(summarizeGitHubTriggers(defaultGitHubTriggers())).toBe(
      "Fires on PR updates and comments from humans.",
    );
  });
  test("anyone PR only", () => {
    expect(summarizeGitHubTriggers(matrix(true, false, true, false))).toBe(
      "Fires on PR updates from anyone.",
    );
  });
  test("nothing", () => {
    expect(summarizeGitHubTriggers(matrix(false, false, false, false))).toBe("No GitHub triggers.");
  });
  test("advanced non-default branch appends a clause", () => {
    const m = matrix(true, false, false, false, {
      advanced: { base: ["release/*"], labels: [], draft: false, repo: ["*/*"] },
    });
    expect(summarizeGitHubTriggers(m)).toContain("targeting release/*");
  });
});
