import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repair-cli rejects alternate runtimes before probing or installing Claude", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "errandd-repair-"));
  dirs.push(cwd);
  const modulePath = fileURLToPath(new URL("../commands/repair-cli.ts", import.meta.url));
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { repairCli } from ${JSON.stringify(modulePath)}; await repairCli(["--force"]);`,
    ],
    {
      cwd,
      env: { ...process.env, ERRANDD_RUNTIME: "codex", CODEX_EXECUTABLE: "/missing-codex" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(output).toContain("repair-cli manages Claude Code only");
});
