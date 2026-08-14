import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliHealth } from "../cliHealth";
import {
  CLI_BINARY_BYTES,
  CLI_INSTALL_MIN_FREE_BYTES,
  checkInstallHeadroom,
  defaultInstallRoot,
  freeBytesAt,
  installCli,
  isEnospc,
} from "../cliInstall";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "errandd-install-"));
  dirs.push(dir);
  return dir;
}

const healthy = (version: string): CliHealth => ({
  ok: true,
  version,
  checkedAt: 0,
  error: null,
  executable: "claude",
});

const broken = (error: string): CliHealth => ({
  ok: false,
  version: null,
  checkedAt: 0,
  error,
  executable: "claude",
});

/** Stand-in for `bun add -g`: drops a binary of `contents` in <root>/bin. */
function fakeInstaller(contents: string) {
  return async (ctx: { root: string; spec: string }) => {
    mkdirSync(join(ctx.root, "bin"), { recursive: true });
    writeFileSync(join(ctx.root, "bin", "claude"), contents);
    return { exitCode: 0, output: `installed ${ctx.spec}` };
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("freeBytesAt", () => {
  it("measures the filesystem holding a path, even one not created yet", () => {
    const free = freeBytesAt(join(tmp(), "does", "not", "exist"));
    expect(free).not.toBeNull();
    expect(free).toBeGreaterThan(0);
  });
});

describe("checkInstallHeadroom", () => {
  it("refuses when the mount is nearly full, naming the shortfall", () => {
    // The incident: 5.8M free on the mount the CLI lives on.
    const result = checkInstallHeadroom("/home/claude/state/cli", {
      freeBytes: () => 5_800_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("/home/claude/state/cli");
    expect(result.error).toContain("refusing to install");
    expect(result.requiredBytes).toBe(CLI_INSTALL_MIN_FREE_BYTES);
  });

  it("refuses when free space cannot be determined", () => {
    const result = checkInstallHeadroom("/some/mount", { freeBytes: () => null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot determine free space");
  });

  it("demands comfortably more than the ~310MB binary", () => {
    expect(CLI_INSTALL_MIN_FREE_BYTES).toBeGreaterThan(2 * CLI_BINARY_BYTES);
    expect(checkInstallHeadroom("/mount", { freeBytes: () => 400_000_000 }).ok).toBe(false);
    expect(checkInstallHeadroom("/mount", { freeBytes: () => 20e9 }).ok).toBe(true);
  });
});

describe("isEnospc", () => {
  it("recognizes the out-of-space signatures installers print", () => {
    expect(isEnospc("error: ENOSPC: no space left on device")).toBe(true);
    expect(isEnospc("write failed: No space left on device")).toBe(true);
    expect(isEnospc("404 not found")).toBe(false);
  });
});

describe("installCli", () => {
  it("refuses on low disk without touching the existing install", async () => {
    const root = tmp();
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "claude"), "old-but-working");
    let ran = false;

    const result = await installCli({
      root,
      headroom: { freeBytes: () => 5_800_000 },
      runInstall: async () => {
        ran = true;
        return { exitCode: 0, output: "" };
      },
      smoke: async () => healthy("2.1.231"),
    });

    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
    expect(result.error).toContain("refusing to install");
    expect(readFileSync(join(root, "bin", "claude"), "utf8")).toBe("old-but-working");
  });

  it("swaps a verified install into place", async () => {
    const root = tmp();
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "claude"), "old");

    const result = await installCli({
      root,
      version: "2.1.231",
      headroom: { freeBytes: () => 20e9 },
      runInstall: fakeInstaller("new-full-size-binary"),
      smoke: async () => healthy("2.1.231"),
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2.1.231");
    expect(readFileSync(join(root, "bin", "claude"), "utf8")).toBe("new-full-size-binary");
    expect(existsSync(`${root}.staging`)).toBe(false);
    expect(existsSync(`${root}.previous`)).toBe(false);
  });

  it("discards a staged install whose smoke test fails, keeping the old CLI", async () => {
    const root = tmp();
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "claude"), "old-but-working");

    const result = await installCli({
      root,
      headroom: { freeBytes: () => 20e9 },
      runInstall: fakeInstaller("truncated"),
      smoke: async () => broken("panic(main thread): Bus error at address 0x128815A6"),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Bus error");
    expect(readFileSync(join(root, "bin", "claude"), "utf8")).toBe("old-but-working");
    expect(existsSync(`${root}.staging`)).toBe(false);
  });

  it("names ENOSPC explicitly, even when the installer exits 0", async () => {
    const root = tmp();
    const result = await installCli({
      root,
      headroom: { freeBytes: () => 20e9 },
      runInstall: async () => ({ exitCode: 0, output: "ENOSPC: no space left on device" }),
      smoke: async () => healthy("2.1.231"),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOSPC");
    expect(existsSync(join(root, "bin", "claude"))).toBe(false);
  });
});

describe("defaultInstallRoot", () => {
  it("follows BUN_INSTALL, falling back to ~/.bun", () => {
    expect(defaultInstallRoot({ BUN_INSTALL: "/home/claude/state/cli" })).toBe(
      "/home/claude/state/cli",
    );
    expect(defaultInstallRoot({ HOME: "/home/claude" })).toBe("/home/claude/.bun");
  });
});
