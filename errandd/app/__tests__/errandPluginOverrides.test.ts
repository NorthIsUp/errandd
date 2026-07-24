import { describe, test, expect } from "bun:test";
import { resolvePluginKey, computeRunPluginOverrides } from "../errandPluginOverrides";

// Note: computeRunPluginOverrides reads the GLOBAL enabledPlugins from
// process.cwd()/.claude/settings.json. In the test sandbox that file is absent,
// so the global map is the empty set and the merged map is just the overrides
// resolved against the fallback "<plugin>@<plugin>" convention. resolvePluginKey
// is tested directly against an explicit global map.

describe("resolvePluginKey", () => {
  const global = { "caveman@caveman": true, "code-review@claude-plugins-official": true };

  test("maps <plugin>/<skill> to the global <plugin>@<marketplace> key", () => {
    expect(resolvePluginKey("caveman/caveman", global)).toBe("caveman@caveman");
  });

  test("resolves a bare <plugin> against the global map", () => {
    expect(resolvePluginKey("code-review", global)).toBe("code-review@claude-plugins-official");
  });

  test("passes through an explicit <plugin>@<marketplace> key", () => {
    expect(resolvePluginKey("ponytail@ponytail", global)).toBe("ponytail@ponytail");
    // even with a trailing /skill tail
    expect(resolvePluginKey("ponytail@ponytail/ponytail", global)).toBe("ponytail@ponytail");
  });

  test("falls back to <plugin>@<plugin> when not in the global map", () => {
    expect(resolvePluginKey("ponytail/ponytail", {})).toBe("ponytail@ponytail");
  });

  test("returns null for an empty token", () => {
    expect(resolvePluginKey("   ", global)).toBeNull();
  });
});

describe("computeRunPluginOverrides", () => {
  test("returns null when the routine declares no overrides", () => {
    expect(computeRunPluginOverrides(undefined, undefined)).toBeNull();
    expect(computeRunPluginOverrides([], [])).toBeNull();
  });

  test("disable turns the resolved key off in the merged map", () => {
    const r = computeRunPluginOverrides(undefined, ["caveman/caveman"]);
    expect(r).not.toBeNull();
    expect(r?.enabledPlugins["caveman@caveman"]).toBe(false);
    // settingsJson round-trips to the same map under an enabledPlugins key.
    expect(JSON.parse(r!.settingsJson)).toEqual({ enabledPlugins: r!.enabledPlugins });
  });

  test("enable turns the resolved key on", () => {
    const r = computeRunPluginOverrides(["ponytail/ponytail"], undefined);
    expect(r?.enabledPlugins["ponytail@ponytail"]).toBe(true);
  });

  test("disable wins over enable on a token collision", () => {
    const r = computeRunPluginOverrides(["caveman/caveman"], ["caveman/caveman"]);
    expect(r?.enabledPlugins["caveman@caveman"]).toBe(false);
  });
});
