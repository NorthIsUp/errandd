/**
 * Reap superseded plugin-cache versions.
 *
 * `claude plugin update` extracts each new version into its own directory under
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and never removes
 * the old one. With the daemon's scheduled auto-update (default every 3h) that
 * accumulates forever — on the deployed daemon it reached 3.8G across 14
 * marketplaces, one plugin alone holding 11 versions back to a fortnight prior,
 * which is what filled the 10Gi state volume and crashlooped the pod.
 *
 * Keeps the ACTIVE version (whatever `installed_plugins.json` points at) plus
 * enough of the newest to reach `KEEP` per plugin, and deletes the rest.
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Version dirs to keep per plugin, the active one included. One spare lets a
 *  bad update be rolled back without a re-download. */
const KEEP = 2;

/** Default plugins root. Resolved per call, not at import, so it stays testable. */
function defaultPluginsDir(): string {
  return join(homedir(), ".claude", "plugins");
}

/**
 * The trailing `<marketplace>/<plugin>/<version>` of a cache path.
 *
 * `installed_plugins.json` spells `installPath` through the `~/.claude` symlink
 * (`/home/claude/.claude/plugins/cache/…`) while the real directory is on the
 * volume (`/home/claude/state/claude/plugins/cache/…`). Comparing absolute
 * paths would match nothing, so key on the last three segments instead.
 */
function cacheKey(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 3 ? parts.slice(-3).join("/") : null;
}

/** Cache keys of every currently-installed plugin version. */
function activeKeys(parsed: unknown): Set<string> {
  const keys = new Set<string>();
  if (typeof parsed !== "object" || parsed === null) {
    return keys;
  }
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (typeof plugins !== "object" || plugins === null) {
    return keys;
  }
  for (const entries of Object.values(plugins as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const installPath = (entry as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath === "string") {
        const key = cacheKey(installPath);
        if (key) {
          keys.add(key);
        }
      }
    }
  }
  return keys;
}

/** Recursive apparent size, for reporting what a prune actually reclaimed. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // vanished mid-walk — ignore
      }
    }
  }
  return total;
}

/** `<marketplace>/<plugin>` directories that hold version subdirectories. */
async function pluginDirs(cacheDir: string): Promise<string[]> {
  const out: string[] = [];
  let marketplaces;
  try {
    marketplaces = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return out; // no cache dir — nothing to do
  }
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) {
      continue;
    }
    const marketplacePath = join(cacheDir, marketplace.name);
    let plugins;
    try {
      plugins = await readdir(marketplacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (plugin.isDirectory()) {
        out.push(join(marketplacePath, plugin.name));
      }
    }
  }
  return out;
}

/**
 * Delete superseded version dirs. Idempotent; returns a one-line summary (empty
 * when nothing was reclaimed) per the maintenance-harness contract.
 */
export async function prunePluginCache(pluginsDir = defaultPluginsDir()): Promise<string> {
  const cacheDir = join(pluginsDir, "cache");
  let active: Set<string>;
  try {
    active = activeKeys(JSON.parse(await readFile(join(pluginsDir, "installed_plugins.json"), "utf-8")));
  } catch {
    return ""; // unreadable metadata — see below, never prune blind
  }
  // Deleting the running plugin would break every agent spawn, so an empty or
  // unparseable manifest means we cannot tell active from stale: do nothing.
  if (active.size === 0) {
    return "";
  }

  let removedDirs = 0;
  let reclaimed = 0;

  for (const pluginDir of await pluginDirs(cacheDir)) {
    let versions;
    try {
      versions = (await readdir(pluginDir, { withFileTypes: true })).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    if (versions.length <= KEEP) {
      continue;
    }

    // Newest first, so "keep the newest few" is a prefix of this list.
    const withTime = await Promise.all(
      versions.map(async (entry) => {
        const full = join(pluginDir, entry.name);
        let mtime = 0;
        try {
          mtime = (await stat(full)).mtimeMs;
        } catch {
          // unreadable — sorts oldest, and is a prune candidate
        }
        return { full, mtime, key: cacheKey(full) };
      }),
    );
    withTime.sort((a, b) => b.mtime - a.mtime);

    const keep = new Set<string>();
    for (const v of withTime) {
      if (v.key && active.has(v.key)) {
        keep.add(v.full);
      }
    }
    for (const v of withTime) {
      if (keep.size >= KEEP) {
        break;
      }
      keep.add(v.full);
    }

    for (const v of withTime) {
      if (keep.has(v.full)) {
        continue;
      }
      const size = await dirSize(v.full);
      try {
        await rm(v.full, { recursive: true, force: true });
        removedDirs += 1;
        reclaimed += size;
      } catch {
        // locked / racing an install — leave it for the next tick
      }
    }
  }

  if (removedDirs === 0) {
    return "";
  }
  const mib = (reclaimed / 1024 / 1024).toFixed(0);
  return `removed ${removedDirs} superseded plugin version(s), reclaimed ~${mib}MiB`;
}
