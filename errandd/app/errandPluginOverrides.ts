/**
 * Per-errand plugin overrides — a routine's `enable:` / `disable:` frontmatter
 * turned into a PER-RUN Claude Code settings object, applied only to that one
 * spawn.
 *
 * Native plugin enable/disable is keyed in `.claude/settings.json` under
 * `enabledPlugins["<plugin>@<marketplace>"] = true|false`. Boot preflight writes
 * the GLOBAL defaults there (see app/preflight.ts → enableInProject). This module
 * NEVER mutates that shared file: instead it reads the global map, applies the
 * routine's overrides on top, and hands the fully-merged map to the spawn via
 * `claude --settings <json>` (a per-invocation additional-settings layer). So a
 * routine that turns caveman off affects only its own run; a sibling routine
 * with no override still sees the global default.
 *
 * The frontmatter token is `<plugin>/<skill>` (e.g. `caveman/caveman`). v1
 * resolves it to a WHOLE-PLUGIN key `<plugin>@<marketplace>` — per-skill
 * granularity within a multi-skill plugin is not supported yet (the whole plugin
 * is toggled; see resolvePluginKey). A bare `<plugin>` or an explicit
 * `<plugin>@<marketplace>` are also accepted.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where boot preflight records the global enabledPlugins defaults. */
function globalSettingsPath(): string {
  return join(process.cwd(), ".claude", "settings.json");
}

/** Read the global `enabledPlugins` map (plugin-key → bool). Fails OPEN to an
 *  empty map on a missing/corrupt file — a broken read must never crash a run. */
export function readGlobalEnabledPlugins(): Record<string, boolean> {
  try {
    const path = globalSettingsPath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      enabledPlugins?: unknown;
    };
    const ep = parsed.enabledPlugins;
    if (!ep || typeof ep !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(ep as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Resolve a frontmatter override token to an `enabledPlugins` key.
 *
 *  - `caveman@caveman` (already a full key) → used verbatim (any `/skill` tail
 *    is stripped).
 *  - `caveman/caveman` or bare `caveman` → take the plugin name (before the
 *    first `/`), then find the global key `^<plugin>@…`. If the plugin isn't in
 *    the global map yet, fall back to `<plugin>@<plugin>` — the convention both
 *    caveman and ponytail follow (marketplace name == plugin name) — so a
 *    disable still lands before the map is first populated.
 *
 *  The `<skill>` half of `<plugin>/<skill>` is intentionally ignored in v1:
 *  toggling is whole-plugin only. */
export function resolvePluginKey(
  token: string,
  globalEnabled: Record<string, boolean>,
): string | null {
  const t = token.trim();
  if (!t) return null;

  // Already a full "<plugin>@<marketplace>" key (drop any trailing "/skill").
  if (t.includes("@")) {
    return t.split("/", 1)[0] ?? t;
  }

  // "<plugin>/<skill>" or bare "<plugin>" → plugin is everything before "/".
  const plugin = (t.split("/", 1)[0] ?? t).trim();
  if (!plugin) return null;

  const prefix = `${plugin}@`;
  const existing = Object.keys(globalEnabled).find((k) => k.startsWith(prefix));
  return existing ?? `${plugin}@${plugin}`;
}

export interface RunPluginOverrides {
  /** The fully-merged per-run map (global defaults + this run's overrides). */
  enabledPlugins: Record<string, boolean>;
  /** JSON string suitable for `claude --settings <json>`. */
  settingsJson: string;
}

/** Compute the per-run enabledPlugins map for a routine's overrides, or `null`
 *  when the routine declares none (so the caller passes no `--settings` and the
 *  spawn is byte-identical to before). `disable` wins over `enable` on a token
 *  collision — a routine that both enables and disables the same plugin gets it
 *  OFF (the safer, more explicit intent). */
export function computeRunPluginOverrides(
  enable: string[] | undefined,
  disable: string[] | undefined,
): RunPluginOverrides | null {
  const enableTokens = enable ?? [];
  const disableTokens = disable ?? [];
  if (enableTokens.length === 0 && disableTokens.length === 0) return null;

  const global = readGlobalEnabledPlugins();
  const merged: Record<string, boolean> = { ...global };

  for (const token of enableTokens) {
    const key = resolvePluginKey(token, global);
    if (key) merged[key] = true;
  }
  // disable last so it wins over enable on a collision.
  for (const token of disableTokens) {
    const key = resolvePluginKey(token, global);
    if (key) merged[key] = false;
  }

  return {
    enabledPlugins: merged,
    settingsJson: JSON.stringify({ enabledPlugins: merged }),
  };
}
