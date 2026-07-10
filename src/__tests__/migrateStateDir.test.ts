import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { migrateStateDir, HEARTBEAT_DIR, LEGACY_HEARTBEAT_DIRS } from "../commands/start";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "errandd-migrate-"));
}

/** Seed a state dir with a marker file so we can prove *which* dir survived. */
async function seed(dir: string, marker: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "web.token"), marker);
}

test("carries the immediately-preceding brand's state forward (clawdcode → errandd)", async () => {
  const root = await tmp();
  const current = join(root, "errandd");
  const legacies = [join(root, "clawdcode"), join(root, "claudeclaw")];
  await seed(legacies[0], "from-clawdcode");

  await migrateStateDir(current, legacies);

  expect(existsSync(current)).toBe(true);
  expect(await readFile(join(current, "web.token"), "utf8")).toBe("from-clawdcode");
  expect(existsSync(legacies[0])).toBe(false);
  await rm(root, { recursive: true, force: true });
});

test("falls back to a two-generation-old brand (claudeclaw → errandd)", async () => {
  const root = await tmp();
  const current = join(root, "errandd");
  const legacies = [join(root, "clawdcode"), join(root, "claudeclaw")];
  await seed(legacies[1], "from-claudeclaw");

  await migrateStateDir(current, legacies);

  expect(await readFile(join(current, "web.token"), "utf8")).toBe("from-claudeclaw");
  await rm(root, { recursive: true, force: true });
});

test("newest legacy wins when several exist", async () => {
  const root = await tmp();
  const current = join(root, "errandd");
  const legacies = [join(root, "clawdcode"), join(root, "claudeclaw")];
  await seed(legacies[0], "from-clawdcode");
  await seed(legacies[1], "from-claudeclaw");

  await migrateStateDir(current, legacies);

  expect(await readFile(join(current, "web.token"), "utf8")).toBe("from-clawdcode");
  await rm(root, { recursive: true, force: true });
});

test("never clobbers existing state when the current dir is already present", async () => {
  const root = await tmp();
  const current = join(root, "errandd");
  const legacies = [join(root, "clawdcode")];
  await seed(current, "live-state");
  await seed(legacies[0], "stale-legacy");

  await migrateStateDir(current, legacies);

  expect(await readFile(join(current, "web.token"), "utf8")).toBe("live-state");
  expect(existsSync(legacies[0])).toBe(true); // legacy left untouched
  await rm(root, { recursive: true, force: true });
});

test("no-op when nothing to migrate", async () => {
  const root = await tmp();
  const current = join(root, "errandd");

  await migrateStateDir(current, [join(root, "clawdcode")]);

  expect(existsSync(current)).toBe(false);
  await rm(root, { recursive: true, force: true });
});

// Regression guard for the rename bug: a blanket find/replace once rewrote the
// legacy dir to equal the current dir, silently making migration a no-op and
// orphaning every live install's jobs/sessions/web.token. This asserts on the
// REAL defaults — an injected-arg test cannot catch a bad constant.
test("regression: the real legacy dirs must never include the current dir", () => {
  expect(LEGACY_HEARTBEAT_DIRS).not.toContain(HEARTBEAT_DIR);
  expect(LEGACY_HEARTBEAT_DIRS.length).toBeGreaterThan(0);
  // clawdcode is the brand every live install currently uses — must migrate.
  expect(LEGACY_HEARTBEAT_DIRS.some((d) => d.endsWith("clawdcode"))).toBe(true);
});

test("regression: a legacy dir equal to current is a safe no-op, not a clobber", async () => {
  const root = await tmp();
  const current = join(root, "errandd");
  await seed(current, "live-state");

  await migrateStateDir(current, [current]);

  expect(await readFile(join(current, "web.token"), "utf8")).toBe("live-state");
  await rm(root, { recursive: true, force: true });
});
