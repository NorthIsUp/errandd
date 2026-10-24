import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface StubResponse {
  status?: number;
  json?: unknown;
  bytes?: number[];
}
async function install(responses: Record<string, StubResponse>) {
  const dest = mkdtempSync(join(tmpdir(), "errandd-skill-"));
  dirs.push(dest);
  const script = fileURLToPath(
    new URL("../../../skills/install-skill/install.mjs", import.meta.url),
  );
  const code = `
    const responses = ${JSON.stringify(responses)};
    globalThis.fetch = async (url) => {
      const stub = responses[String(url)];
      if (!stub) throw new Error("Unexpected URL: " + url);
      return stub.bytes ? new Response(new Uint8Array(stub.bytes), { status: stub.status ?? 200 })
        : Response.json(stub.json ?? {}, { status: stub.status ?? 200 });
    };
    process.argv = [process.execPath, ${JSON.stringify(script)}, "owner/repo", "demo", ${JSON.stringify(dest)}];
    await import(${JSON.stringify(script)});
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  return {
    dest,
    result: JSON.parse(output) as { ok?: boolean; files?: string[]; error?: string },
    exitCode: await proc.exited,
  };
}

const listingUrl = "https://api.github.com/repos/owner/repo/contents/skills/demo";
test("skill installer downloads nested assets and preserves binary content", async () => {
  const { dest, result, exitCode } = await install({
    [listingUrl]: {
      json: [
        { type: "file", name: "SKILL.md", download_url: "https://raw/skill" },
        { type: "dir", name: "assets", url: "https://api/assets" },
      ],
    },
    "https://raw/skill": { bytes: [35, 32, 68, 101, 109, 111] },
    "https://api/assets": {
      json: [{ type: "file", name: "icon.png", download_url: "https://raw/icon" }],
    },
    "https://raw/icon": { bytes: [137, 80, 78, 71, 0, 255] },
  });
  expect(exitCode).toBe(0);
  expect(result.ok).toBe(true);
  expect(result.files).toEqual(["SKILL.md", "assets/icon.png"]);
  expect([...readFileSync(join(dest, "demo/assets/icon.png"))]).toEqual([137, 80, 78, 71, 0, 255]);
});

test("skill installer fails on HTTP errors instead of saving error pages", async () => {
  const { dest, result, exitCode } = await install({
    [listingUrl]: { json: [{ type: "file", name: "SKILL.md", download_url: "https://raw/skill" }] },
    "https://raw/skill": { status: 503, bytes: [69, 114, 114, 111, 114] },
  });
  expect(exitCode).toBe(1);
  expect(result.error).toContain("HTTP 503");
  expect(existsSync(join(dest, "demo/SKILL.md"))).toBe(false);
});
