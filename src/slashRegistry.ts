import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { discoverPlugins } from "./jobsRepoPlugins";

export interface SlashEntry {
  name: string;        // bare command name without leading slash
  source: string;      // "plugin:<plugin-name>" | "personal" | "project"
  kind: "skill" | "command";
  description?: string;// from SKILL.md frontmatter or first line of commands/*.md
  /** Plugin/group name (e.g. "gstack") — derived from the SKILL.md path stub
   *  for personal/project skills, or set to the plugin name for plugin-scoped ones. */
  plugin?: string;
}

/**
 * Parse YAML-style frontmatter from a markdown file.
 * Returns an object with any found frontmatter keys. Only handles simple
 * key: value pairs (no multiline). Falls back gracefully if no frontmatter.
 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const result: { name?: string; description?: string } = {};
  if (!content.startsWith("---")) return result;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return result;
  const block = content.slice(3, end);
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // `(.*)` (not `(.+)`) so a key with an empty inline value still matches —
    // that's how YAML block scalars (`description: |` then indented lines) declare themselves.
    const m = /^(\w+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    // Block scalar: collect the indented continuation lines that follow.
    if (/^[|>][+-]?$/.test(val) || val === "") {
      const folded = val.startsWith(">");
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (/^\s+\S/.test(next)) {
          collected.push(next.trim());
        } else if (next.trim() === "") {
          if (collected.length) collected.push("");
        } else {
          break;
        }
      }
      val = collected.join(folded ? " " : "\n").trim();
    }
    val = val.replace(/^["']|["']$/g, "").trim();
    if (!val) continue;
    if (val.length > 200) val = val.slice(0, 199) + "…";
    if (key === "name") result.name = val;
    if (key === "description") result.description = val;
  }
  return result;
}

/**
 * Extract first non-empty, non-frontmatter, non-heading line from a markdown file.
 * Truncated to ~80 chars.
 */
function extractFirstLine(content: string): string | undefined {
  let body = content;
  // Skip frontmatter
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end !== -1) {
      body = content.slice(end + 4);
    }
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Skip blank lines and markdown headings
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.length > 80 ? trimmed.slice(0, 79) + "…" : trimmed;
  }
  return undefined;
}

/**
 * Scan a directory of skills (skills/<name>/SKILL.md) and return SlashEntry items.
 */
/** When a SKILL.md is a one-line path stub (common with plugin-installed skills),
 *  pull the plugin/group name out of the path (the dir under `.claude/skills/`). */
function pluginFromPath(s: string): string | undefined {
  const m = /\/skills\/([^/]+)\/[^/]+\/SKILL\.md\s*$/.exec(s);
  return m ? m[1] : undefined;
}
function isPathLike(s: string): boolean {
  return s.startsWith("/") && s.includes("/SKILL.md");
}

export async function scanSkillsDir(
  dir: string,
  source: string,
): Promise<SlashEntry[]> {
  const entries: SlashEntry[] = [];
  if (!existsSync(dir)) return entries;
  try {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const skillFile = join(dir, item.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      let description: string | undefined;
      let plugin: string | undefined;
      let name = item.name;
      try {
        const content = await readFile(skillFile, "utf-8");
        const fm = parseFrontmatter(content);
        if (fm.name) name = fm.name;
        description = fm.description ?? extractFirstLine(content);
        // Drop noisy path-stub "descriptions"; keep the plugin/group hint from the path.
        if (description && isPathLike(description)) {
          plugin = pluginFromPath(description);
          description = undefined;
        }
      } catch {}
      entries.push({ name, source, kind: "skill", description, plugin });
    }
  } catch {}
  return entries;
}

/**
 * Scan a directory of commands (commands/*.md) and return SlashEntry items.
 */
export async function scanCommandsDir(
  dir: string,
  source: string,
): Promise<SlashEntry[]> {
  const entries: SlashEntry[] = [];
  if (!existsSync(dir)) return entries;
  try {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isFile() || !item.name.endsWith(".md")) continue;
      const name = item.name.slice(0, -3); // strip .md
      let description: string | undefined;
      try {
        const content = await readFile(join(dir, item.name), "utf-8");
        description = extractFirstLine(content);
      } catch {}
      entries.push({ name, source, kind: "command", description });
    }
  } catch {}
  return entries;
}

/**
 * List all slash-invokable entries from:
 * 1. Plugin skills and commands (from all configured jobs-repo plugins)
 * 2. Personal skills (~/.claude/skills/) and commands (~/.claude/commands/)
 * 3. Project skills (<cwd>/.claude/skills/) and commands (<cwd>/.claude/commands/)
 *
 * Deduplication: project > personal > plugin (first occurrence wins).
 * Final list is sorted alphabetically by name.
 *
 * Accepts optional overrides for home and cwd to facilitate testing.
 */
export async function listAllSlashEntries(
  opts: { home?: string; cwd?: string } = {},
): Promise<SlashEntry[]> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  // Collect in precedence order: project first, then personal, then plugin
  const projectEntries: SlashEntry[] = [
    ...await scanSkillsDir(join(cwd, ".claude", "skills"), "project"),
    ...await scanCommandsDir(join(cwd, ".claude", "commands"), "project"),
  ];

  const personalEntries: SlashEntry[] = [
    ...await scanSkillsDir(join(home, ".claude", "skills"), "personal"),
    ...await scanCommandsDir(join(home, ".claude", "commands"), "personal"),
  ];

  const pluginEntries: SlashEntry[] = [];
  try {
    const plugins = await discoverPlugins();
    for (const plugin of plugins) {
      for (const skillName of plugin.skills) {
        const skillFile = join(plugin.dir, "skills", skillName, "SKILL.md");
        let description: string | undefined;
        let name = skillName;
        try {
          const content = await readFile(skillFile, "utf-8");
          const fm = parseFrontmatter(content);
          if (fm.name) name = fm.name;
          description = fm.description ?? extractFirstLine(content);
        } catch {}
        pluginEntries.push({
          name,
          source: `plugin:${plugin.name}`,
          kind: "skill",
          description,
          plugin: plugin.name,
        });
      }
      for (const cmdName of plugin.commands) {
        const cmdFile = join(plugin.dir, "commands", `${cmdName}.md`);
        let description: string | undefined;
        try {
          const content = await readFile(cmdFile, "utf-8");
          description = extractFirstLine(content);
        } catch {}
        pluginEntries.push({
          name: cmdName,
          source: `plugin:${plugin.name}`,
          kind: "command",
          description,
          plugin: plugin.name,
        });
      }
    }
  } catch {}

  // Dedupe: project > personal > plugin (first occurrence wins)
  const seen = new Set<string>();
  const result: SlashEntry[] = [];

  for (const entry of [...projectEntries, ...personalEntries, ...pluginEntries]) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      result.push(entry);
    }
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
