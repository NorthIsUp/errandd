import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { getSettings } from "./config";

export interface JobsRepoPlugin {
  name: string;    // from .claude-plugin/plugin.json "name", or directory basename
  dir: string;     // absolute path to the plugin directory
  skills: string[]; // skill names (skills/<name>/SKILL.md)
  commands: string[]; // command names (commands/<name>.md)
  agents: string[];   // agent names (agents/<name>.md)
}

/** Check if a directory contains a .claude-plugin/plugin.json file. */
async function isPluginDir(dir: string): Promise<boolean> {
  return existsSync(join(dir, ".claude-plugin", "plugin.json"));
}

/** Read plugin metadata from a directory. */
async function readPlugin(dir: string): Promise<JobsRepoPlugin> {
  let name = basename(dir);
  try {
    const raw = await readFile(join(dir, ".claude-plugin", "plugin.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.name === "string" && parsed.name.trim()) {
      name = parsed.name.trim();
    }
  } catch {}

  // List skills: skills/*/SKILL.md → skill name is the directory name
  const skills: string[] = [];
  const skillsDir = join(dir, "skills");
  if (existsSync(skillsDir)) {
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md"))) {
          skills.push(entry.name);
        }
      }
      skills.sort();
    } catch {}
  }

  // List commands: commands/*.md → command name is the file stem
  const commands: string[] = [];
  const commandsDir = join(dir, "commands");
  if (existsSync(commandsDir)) {
    try {
      const entries = await readdir(commandsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          commands.push(entry.name.slice(0, -3));
        }
      }
      commands.sort();
    } catch {}
  }

  // List agents: agents/*.md → agent name is the file stem
  const agents: string[] = [];
  const agentsDir = join(dir, "agents");
  if (existsSync(agentsDir)) {
    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          agents.push(entry.name.slice(0, -3));
        }
      }
      agents.sort();
    } catch {}
  }

  return { name, dir, skills, commands, agents };
}

/**
 * Scan a single source directory for plugin directories (bounded — no
 * deep recursion). A plugin directory is one containing
 * .claude-plugin/plugin.json.
 *
 * Scan locations:
 *   - the source root itself
 *   - each immediate subdirectory of the source root
 *   - each immediate subdirectory of a plugins/ folder if one exists
 *
 * Returns [] when the dir doesn't exist or repoConfigured is false. Works
 * for both git clones (which have `.git`) and `claude plugin install`
 * targets (which don't).
 */
export async function discoverPluginsForDir(
  repoDir: string,
  repoConfigured = true,
): Promise<JobsRepoPlugin[]> {
  if (!repoConfigured) return [];
  if (!existsSync(repoDir)) return [];

  const seen = new Set<string>();
  const plugins: JobsRepoPlugin[] = [];

  async function tryAdd(dir: string): Promise<void> {
    if (seen.has(dir)) return;
    seen.add(dir);
    if (await isPluginDir(dir)) {
      plugins.push(await readPlugin(dir));
    }
  }

  // Check the repo root itself
  await tryAdd(repoDir);

  // Check each immediate subdirectory of the repo root
  try {
    const rootEntries = await readdir(repoDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await tryAdd(join(repoDir, entry.name));
      }
    }

    // Check each immediate subdirectory of plugins/ if it exists
    const pluginsSubdir = join(repoDir, "plugins");
    if (existsSync(pluginsSubdir)) {
      const pluginEntries = await readdir(pluginsSubdir, { withFileTypes: true });
      for (const entry of pluginEntries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          await tryAdd(join(pluginsSubdir, entry.name));
        }
      }
    }
  } catch {}

  // Sort by dir for deterministic ordering
  plugins.sort((a, b) => a.dir.localeCompare(b.dir));

  return plugins;
}

/**
 * Scan ALL configured repos for plugins.
 * Returns the concatenation of discoverPluginsForDir() for each repo, in config order.
 */
export async function discoverPlugins(): Promise<JobsRepoPlugin[]> {
  const { jobsRepos } = getSettings();
  const { getJobsRepoDirForRepo } = await import("./config");
  const allPlugins: JobsRepoPlugin[] = [];
  for (const repo of jobsRepos) {
    if (!repo.url) continue;
    const dir = getJobsRepoDirForRepo(repo);
    const plugins = await discoverPluginsForDir(dir, true);
    allPlugins.push(...plugins);
  }
  return allPlugins;
}

/**
 * @deprecated Use discoverPlugins() for multi-repo.
 * Kept for back-compat with existing tests that mock the config module
 * to inject a single-repo config.
 */
export async function discoverJobsRepoPlugins(): Promise<JobsRepoPlugin[]> {
  const { getSettings: gs, getJobsRepoDir } = await import("./config");
  const settings = gs();
  const { jobsRepo } = settings;
  if (!jobsRepo.url) return [];

  // Use the new multi-repo discovery if jobsRepos is populated
  if (settings.jobsRepos && settings.jobsRepos.length > 0) {
    return discoverPlugins();
  }

  // Legacy path: single jobsRepo
  const repoDir = getJobsRepoDir();
  return discoverPluginsForDir(repoDir, true);
}

/**
 * Build the spawn flags to pass to a claude subprocess, aggregating all repos.
 *
 * - If plugins found across any repo → ["--plugin-dir", p.dir, ...] for each plugin
 * - Else if root .claude/skills/ exists in any repo → ["--add-dir", repoRoot] for that repo
 * - Else → []
 */
export async function getJobsRepoSpawnArgs(): Promise<string[]> {
  const { jobsRepos, jobsRepo } = getSettings();
  const { getJobsRepoDirForRepo, getJobsRepoDir } = await import("./config");

  // Determine list of repo dirs to scan
  const repoDirs: string[] = [];
  if (jobsRepos && jobsRepos.length > 0) {
    for (const repo of jobsRepos) {
      if (repo.url) repoDirs.push(getJobsRepoDirForRepo(repo));
    }
  } else if (jobsRepo?.url) {
    // Legacy single-repo
    repoDirs.push(getJobsRepoDir());
  }

  if (repoDirs.length === 0) return [];

  const allPlugins: JobsRepoPlugin[] = [];
  const addDirs: string[] = [];

  for (const repoDir of repoDirs) {
    const plugins = await discoverPluginsForDir(repoDir, true);
    if (plugins.length > 0) {
      allPlugins.push(...plugins);
    } else if (existsSync(join(repoDir, ".claude", "skills"))) {
      addDirs.push(repoDir);
    }
  }

  if (allPlugins.length > 0) {
    const args: string[] = [];
    // allPlugins already sorted by dir within each repo; maintain order
    for (const plugin of allPlugins) {
      args.push("--plugin-dir", plugin.dir);
    }
    return args;
  }

  if (addDirs.length > 0) {
    // --add-dir for the first fallback repo
    return ["--add-dir", addDirs[0]];
  }

  return [];
}
