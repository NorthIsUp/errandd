import { describe, expect, it } from "bun:test";
import { uninstallPlugin } from "../ui/services/claudePlugins";

// Belt-and-suspenders test: even if the UI sends a request, the daemon
// must refuse to uninstall itself. We never call `claude` here — the guard
// short-circuits before any subprocess spawns.
describe("uninstallPlugin: clawdcode self-uninstall guard", () => {
  it("refuses to uninstall clawdcode (any marketplace)", async () => {
    const r1 = await uninstallPlugin("clawdcode");
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/clawdcode cannot uninstall itself/);

    const r2 = await uninstallPlugin("clawdcode@some-marketplace");
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/clawdcode cannot uninstall itself/);
  });

  it("still rejects flag-like ids for non-self plugins", async () => {
    const r = await uninstallPlugin("--scope");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must not start with '-'/);
  });
});
