import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCli,
  getCachedCliHealth,
  onCliHealthChecked,
  parseCliVersion,
  refreshCliHealth,
  resetCliHealth,
} from "../cliHealth";

// The real panic a truncated Bun single-file executable produced on the pod:
// the binary mmaps its own tail, so a short file faults instead of erroring.
const BUS_ERROR_PANIC = [
  "panic(main thread): Bus error at address 0x128815A6",
  "Bun v1.4.0 (8bb8d04c4) Linux arm64",
].join("\n");

const dirs: string[] = [];

function fakeCli(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "errandd-cli-"));
  dirs.push(dir);
  const exe = join(dir, "claude");
  writeFileSync(exe, `#!/bin/sh\n${script}\n`);
  chmodSync(exe, 0o755);
  return exe;
}

afterEach(() => {
  resetCliHealth();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseCliVersion", () => {
  it("pulls the version out of the CLI's banner", () => {
    expect(parseCliVersion("2.1.231 (Claude Code)\n")).toBe("2.1.231");
    expect(parseCliVersion("pi 0.80.6\n")).toBe("0.80.6");
  });

  it("returns null when there is no version to find", () => {
    expect(parseCliVersion("")).toBeNull();
    expect(parseCliVersion("Bus error")).toBeNull();
  });
});

describe("checkCli", () => {
  it("passes a healthy CLI and reports its version", async () => {
    const health = await checkCli({ executable: fakeCli('echo "2.1.231 (Claude Code)"') });
    expect(health.ok).toBe(true);
    expect(health.version).toBe("2.1.231");
    expect(health.error).toBeNull();
  });

  it("detects a corrupt binary and keeps the panic text", async () => {
    const exe = fakeCli(`echo '${BUS_ERROR_PANIC}' >&2; exit 1`);
    const health = await checkCli({ executable: exe });
    expect(health.ok).toBe(false);
    expect(health.version).toBeNull();
    expect(health.error).toContain("Bus error");
    expect(health.error).toContain("exit 1");
    expect(health.executable).toBe(exe);
  });

  it("detects a truncated binary that cannot even be exec'd", async () => {
    // 97,828,864 of 308,795,592 bytes is what ENOSPC left behind; a few bytes
    // of the same nonsense reproduce the "this is not a runnable file" verdict.
    const dir = mkdtempSync(join(tmpdir(), "errandd-cli-"));
    dirs.push(dir);
    const exe = join(dir, "claude");
    writeFileSync(exe, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]));
    chmodSync(exe, 0o755);
    const health = await checkCli({ executable: exe });
    expect(health.ok).toBe(false);
    expect(health.error).toBeTruthy();
  });

  it("fails a CLI that exits 0 but prints no version", async () => {
    const health = await checkCli({ executable: fakeCli('echo "hello"') });
    expect(health.ok).toBe(false);
    expect(health.error).toContain("no version");
  });

  it("fails, rather than throws, when the binary is missing", async () => {
    const health = await checkCli({ executable: "/nonexistent/claude" });
    expect(health.ok).toBe(false);
    expect(health.version).toBeNull();
  });

  it("gives up on a hung CLI instead of wedging the caller", async () => {
    const health = await checkCli({ executable: fakeCli("sleep 30"), timeoutMs: 200 });
    expect(health.ok).toBe(false);
  });
});

describe("refreshCliHealth", () => {
  it("caches the verdict and re-probes when forced", async () => {
    const exe = fakeCli('echo "2.1.231 (Claude Code)"');
    const first = await refreshCliHealth({ executable: exe });
    expect(first.ok).toBe(true);
    expect(getCachedCliHealth()).toEqual(first);
    // Within the TTL a second read must not spawn again — same object.
    expect(await refreshCliHealth({ executable: exe })).toBe(first);
    const forced = await refreshCliHealth({ executable: exe, force: true });
    expect(forced).not.toBe(first);
    expect(forced.ok).toBe(true);
  });

  it("notifies listeners with the previous verdict so a break can page once", async () => {
    const seen: { ok: boolean; previousOk: boolean | null }[] = [];
    onCliHealthChecked((health, previous) => {
      seen.push({ ok: health.ok, previousOk: previous ? previous.ok : null });
    });
    await refreshCliHealth({ executable: fakeCli('echo "2.1.231 (Claude Code)"'), force: true });
    await refreshCliHealth({ executable: fakeCli(`echo '${BUS_ERROR_PANIC}' >&2; exit 1`), force: true });
    expect(seen).toEqual([
      { ok: true, previousOk: null },
      { ok: false, previousOk: true },
    ]);
  });
});
