import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "../../../api/sessions";
import { buildScheduledSection, isScheduledJob, type JobListEntry } from "../scheduled";

function job(name: string, schedules: string[]): JobListEntry {
  return { name, schedules, schedule: schedules[0] ?? "", promptPreview: "" };
}

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    agent: "default",
    channel: "job",
    lastUsedAt: "2026-06-09T10:00:00.000Z",
    createdAt: "2026-06-09T09:00:00.000Z",
    turnCount: 1,
    firstMessage: "",
    lastMessage: "",
    closed: false,
    ...over,
  };
}

describe("isScheduledJob", () => {
  test("true only when schedules is non-empty", () => {
    expect(isScheduledJob(job("a", ["*/5 * * * *"]))).toBe(true);
    expect(isScheduledJob(job("b", []))).toBe(false);
  });
});

describe("buildScheduledSection", () => {
  test("scheduled routines appear even with no runs (e.g. dependabot-merge)", () => {
    const section = buildScheduledSection(
      [job("dependabot-merge", ["0 * * * *"]), job("clone-clara-v1", ["@daily"])],
      [],
    );
    expect(section.source).toBe("routines");
    expect(section.items.map((i) => i.key).sort()).toEqual(["clone-clara-v1", "dependabot-merge"]);
    expect(section.items.every((i) => i.routines.length === 0)).toBe(true);
  });

  test("event-only jobs (no schedules) are excluded", () => {
    const section = buildScheduledSection([job("pr-review", [])], []);
    expect(section.items).toHaveLength(0);
  });

  test("matches a scheduled run session by jobName + schedule trigger", () => {
    const section = buildScheduledSection(
      [job("nightly", ["@daily"])],
      [
        session({
          id: "nightly:2026-06-09",
          jobName: "nightly",
          trigger: { kind: "schedule", cron: "@daily" },
          result: "ok",
        }),
      ],
    );
    const item = section.items.find((i) => i.key === "nightly");
    expect(item?.routines).toHaveLength(1);
    expect(item?.routines[0]?.threadId).toBe("nightly:2026-06-09");
    expect(item?.routines[0]?.status).toBe("done");
    expect(item?.routines[0]?.outcome).toBe("ok");
  });

  test("does NOT pull in :hook: threads (those belong to other sections)", () => {
    const section = buildScheduledSection(
      [job("pr-review", ["@hourly"])],
      [
        session({
          id: "pr-review:hook:pr-12-foo",
          jobName: "pr-review",
          trigger: { kind: "hook", event: "pull_request" },
          result: "ok",
        }),
      ],
    );
    expect(section.items.find((i) => i.key === "pr-review")?.routines).toHaveLength(0);
  });

  test("maps result → status/outcome: error, pass/skipped, missing", () => {
    const section = buildScheduledSection(
      [job("j", ["@daily"])],
      [
        session({ id: "j:err", jobName: "j", result: "error" }),
        session({ id: "j:skip", jobName: "j", result: "skipped" }),
        // No result + an old timestamp → a finished run of unknown outcome
        // (NOT a misleading spinner on a weeks-old run).
        session({ id: "j:old", jobName: "j", lastUsedAt: "2026-01-01T00:00:00.000Z" }),
        // No result + touched just now → genuinely in-flight.
        session({ id: "j:run", jobName: "j", lastUsedAt: new Date().toISOString() }),
      ],
    );
    const refs = section.items[0]?.routines ?? [];
    const byId = new Map(refs.map((r) => [r.threadId, r]));
    expect(byId.get("j:err")?.status).toBe("failed");
    expect(byId.get("j:err")?.outcome).toBe("error");
    expect(byId.get("j:skip")?.status).toBe("done");
    expect(byId.get("j:skip")?.outcome).toBe("pass");
    expect(byId.get("j:old")?.status).toBe("done");
    expect(byId.get("j:run")?.status).toBe("running");
  });

  test("runs sort newest-first within a routine", () => {
    const section = buildScheduledSection(
      [job("j", ["@daily"])],
      [
        session({ id: "old", jobName: "j", lastUsedAt: "2026-06-09T08:00:00.000Z" }),
        session({ id: "new", jobName: "j", lastUsedAt: "2026-06-09T12:00:00.000Z" }),
      ],
    );
    expect(section.items[0]?.routines.map((r) => r.threadId)).toEqual(["new", "old"]);
  });
});
