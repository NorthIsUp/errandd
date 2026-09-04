import { describe, expect, test } from "bun:test";
import { archiveDays, DEFAULT_AUTO_ARCHIVE_DAYS, planArchive, type TranscriptFile } from "../maintenance/archiveTranscripts";
import { DEFAULT_LOG_RETENTION_DAYS, logRetentionDays, selectExpired } from "../maintenance/pruneLogs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04T12:00:00Z

function transcript(project: string, name: string, ageDays: number): TranscriptFile {
  return { path: `/projects/${project}/${name}.jsonl`, project, mtimeMs: NOW - ageDays * DAY };
}

describe("planArchive", () => {
  const cutoff = NOW - 14 * DAY;

  test("leaves anything newer than the cutoff alone", () => {
    const groups = planArchive([transcript("-home-claude", "fresh", 1), transcript("-home-claude", "yesterday", 13)], cutoff);
    expect(groups).toEqual([]);
  });

  test("groups stale files per project and per UTC day", () => {
    const groups = planArchive(
      [
        transcript("-home-claude", "a", 20),
        transcript("-home-claude", "b", 20),
        transcript("-home-claude", "c", 21),
        transcript("-workspace", "d", 20),
        transcript("-home-claude", "keep", 2),
      ],
      cutoff,
    );

    expect(groups.map((g) => g.key).sort()).toEqual([
      "-home-claude/2026-08-15",
      "-home-claude/2026-08-14",
      "-workspace/2026-08-15",
    ].sort());
    expect(groups.find((g) => g.key === "-home-claude/2026-08-15")?.files).toHaveLength(2);
    expect(groups.flatMap((g) => g.files)).not.toContain("/projects/-home-claude/keep.jsonl");
  });

  test("caps a run at the oldest N files so one tick stays bounded", () => {
    const files = Array.from({ length: 50 }, (_, i) => transcript("-home-claude", `s${i}`, 20 + i));
    const groups = planArchive(files, cutoff, 10);
    const archived = groups.flatMap((g) => g.files);

    expect(archived).toHaveLength(10);
    // Oldest first: s49 (69d) is in, s0 (20d) is not.
    expect(archived).toContain("/projects/-home-claude/s49.jsonl");
    expect(archived).not.toContain("/projects/-home-claude/s0.jsonl");
  });

  test("an empty projects tree is a no-op", () => {
    expect(planArchive([], cutoff)).toEqual([]);
  });
});

describe("archiveDays", () => {
  test("defaults when unset or unparseable", () => {
    expect(archiveDays({})).toBe(DEFAULT_AUTO_ARCHIVE_DAYS);
    expect(archiveDays({ ERRANDD_AUTO_ARCHIVE_DAYS: "  " })).toBe(DEFAULT_AUTO_ARCHIVE_DAYS);
    expect(archiveDays({ ERRANDD_AUTO_ARCHIVE_DAYS: "soon" })).toBe(DEFAULT_AUTO_ARCHIVE_DAYS);
  });

  test("reads an override, and 0 disables", () => {
    expect(archiveDays({ ERRANDD_AUTO_ARCHIVE_DAYS: "7" })).toBe(7);
    expect(archiveDays({ ERRANDD_AUTO_ARCHIVE_DAYS: "0" })).toBe(0);
  });
});

describe("selectExpired", () => {
  test("condemns only logs past the cutoff", () => {
    const files = [
      { name: "old.log", mtimeMs: NOW - 31 * DAY },
      { name: "edge.log", mtimeMs: NOW - 29 * DAY },
      { name: "new.log", mtimeMs: NOW },
    ];
    expect(selectExpired(files, NOW - 30 * DAY)).toEqual(["old.log"]);
  });
});

describe("logRetentionDays", () => {
  test("defaults to 30 and honours an override", () => {
    expect(logRetentionDays({})).toBe(DEFAULT_LOG_RETENTION_DAYS);
    expect(logRetentionDays({ ERRANDD_LOG_RETENTION_DAYS: "7" })).toBe(7);
    expect(logRetentionDays({ ERRANDD_LOG_RETENTION_DAYS: "0" })).toBe(0);
  });
});
