import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadJobRules } from "../runner";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "claw-rules-"));
}

test("returns the first non-empty RULES.md across dirs", async () => {
  const a = await tmp();
  const b = await tmp();
  try {
    await writeFile(join(b, "RULES.md"), "  be the deferring writer  \n");
    // `a` has no RULES.md → skipped; `b` wins. Content is trimmed.
    expect(await loadJobRules([a, b])).toBe("be the deferring writer");
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("earlier dir wins over later", async () => {
  const a = await tmp();
  const b = await tmp();
  try {
    await writeFile(join(a, "RULES.md"), "first");
    await writeFile(join(b, "RULES.md"), "second");
    expect(await loadJobRules([a, b])).toBe("first");
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("empty file is skipped, not returned", async () => {
  const a = await tmp();
  const b = await tmp();
  try {
    await writeFile(join(a, "RULES.md"), "   \n  "); // whitespace-only → empty
    await writeFile(join(b, "RULES.md"), "real rules");
    expect(await loadJobRules([a, b])).toBe("real rules");
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("no RULES.md anywhere → empty string (no throw)", async () => {
  const a = await tmp();
  try {
    expect(await loadJobRules([a, "/nonexistent/dir/xyz"])).toBe("");
  } finally {
    await rm(a, { recursive: true, force: true });
  }
});
