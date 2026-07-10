import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { migrateFrontmatterText } from "../migrateTriggers";

/** Parse the frontmatter mapping out of a migrated doc for assertions. */
function fm(content: string): Record<string, unknown> {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return (parseYaml(m?.[1] ?? "") ?? {}) as Record<string, unknown>;
}

describe("migrateFrontmatterText", () => {
  test("schedule + on-mapping → on: list, recurring preserved", () => {
    const old =
      '---\nschedule: "0 9 * * *"\nrecurring: true\nnotify: error\non:\n  prs: true\n  comments: true\n---\nbody\n';
    const next = migrateFrontmatterText(old);
    expect(next).not.toBeNull();
    const f = fm(next!);
    expect(f.schedule).toBeUndefined();
    expect(f.recurring).toBe(true);
    expect(f.notify).toBe("error");
    expect(f.on).toEqual([{ schedule: "0 9 * * *" }, { prs: true }, { comments: true }]);
  });

  test("event-only on-mapping (no schedule) migrates to a list", () => {
    const old = "---\nnotify: error\non:\n  comments: true\n  prs: true\n---\nreview\n";
    const f = fm(migrateFrontmatterText(old)!);
    expect(f.on).toEqual([{ prs: true }, { comments: true }]);
    expect(f.schedule).toBeUndefined();
  });

  test("skip_self moves from on-mapping to top-level", () => {
    const old = "---\non:\n  comments: true\n  skip_self: false\n---\nx\n";
    const f = fm(migrateFrontmatterText(old)!);
    expect(f.skip_self).toBe(false);
    expect(f.on).toEqual([{ comments: true }]);
  });

  test("schedule-only routine becomes a single-entry list", () => {
    const old = '---\nschedule: "*/5 * * * *"\nrecurring: true\n---\ntick\n';
    const f = fm(migrateFrontmatterText(old)!);
    expect(f.on).toEqual([{ schedule: "*/5 * * * *" }]);
  });

  test("pr rules carry over (list form)", () => {
    const old =
      '---\non:\n  pr:\n    - repo: "*/*"\n      user: ["*"]\n---\nx\n';
    const f = fm(migrateFrontmatterText(old)!);
    expect(f.on).toEqual([{ pr: { repo: "*/*", user: ["*"] } }]);
  });

  test("idempotent: already new-form returns null (no change)", () => {
    const newForm = '---\nrecurring: true\non:\n  - schedule: "0 9 * * *"\n  - comments: true\n---\nx\n';
    expect(migrateFrontmatterText(newForm)).toBeNull();
  });

  test("no frontmatter → null", () => {
    expect(migrateFrontmatterText("just a markdown file\n")).toBeNull();
  });
});
