import { test, expect, mock } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, basename } from "path";

// We need to mock the config module before importing our module
// We'll use dynamic imports with a fresh module cache per test group

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ccplugins-"));
}

async function makePlugin(
  dir: string,
  opts: {
    name?: string;
    skills?: string[];
    commands?: string[];
    noManifest?: boolean;
  } = {}
): Promise<void> {
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  if (!opts.noManifest) {
    const manifest = opts.name ? { name: opts.name } : {};
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify(manifest)
    );
  }
  for (const skill of opts.skills ?? []) {
    await mkdir(join(dir, "skills", skill), { recursive: true });
    await writeFile(join(dir, "skills", skill, "SKILL.md"), `# ${skill}\n`);
  }
  for (const cmd of opts.commands ?? []) {
    await mkdir(join(dir, "commands"), { recursive: true });
    await writeFile(join(dir, "commands", `${cmd}.md`), `# ${cmd}\n`);
  }
}

// Helper to create a fake git repo (just .git dir for isCloned check)
async function initFakeGitRepo(dir: string): Promise<void> {
  await mkdir(join(dir, ".git"), { recursive: true });
}

// We need to mock the config module to return our temp dirs
// We'll do this by directly testing the internal functions via a helper approach

// Since the module uses getSettings() and getJobsRepoDir() at call time (not module load),
// we can test the discovery logic by setting up temp dirs and calling through a wrapper
// that overrides the module's dependencies.

// Strategy: import the functions and patch the config module's exports.

// Actually, bun:test's mock.module can intercept module imports for subsequent dynamic imports.
// Let's use a direct approach: create a test helper that creates real temp structures,
// and temporarily point the module's config functions to return the temp paths.

// Since getSettings() and getJobsRepoDir() are module-level singletons, we need to
// import the functions from our module and intercept their deps. The cleanest approach
// for Bun is to re-export testable internals or use mock.module.

// We'll use mock.module to patch the config module for each test.

test("discoverJobsRepoPlugins — single root plugin returns one entry", async () => {
  const repoDir = await tmp();
  try {
    await initFakeGitRepo(repoDir);
    await makePlugin(repoDir, { name: "my-tools", skills: ["system-check"], commands: ["deploy"] });

    void mock.module("../config", () => ({
      getSettings: () => ({ jobsRepo: { url: "https://example.com/repo.git", branch: "main" } }),
      getJobsRepoDir: () => repoDir,
    }));

    const { discoverJobsRepoPlugins } = await import("../jobsRepoPlugins");
    const plugins = await discoverJobsRepoPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("my-tools");
    expect(plugins[0].dir).toBe(repoDir);
    expect(plugins[0].skills).toEqual(["system-check"]);
    expect(plugins[0].commands).toEqual(["deploy"]);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("discoverJobsRepoPlugins — plugins under plugins/ subdirectory", async () => {
  const repoDir = await tmp();
  try {
    await initFakeGitRepo(repoDir);
    // Two plugins under plugins/
    const pluginsDir = join(repoDir, "plugins");
    await mkdir(join(pluginsDir, "alpha"), { recursive: true });
    await mkdir(join(pluginsDir, "beta"), { recursive: true });
    await makePlugin(join(pluginsDir, "alpha"), { name: "alpha-plugin", skills: ["skill-a"] });
    await makePlugin(join(pluginsDir, "beta"), { name: "beta-plugin", skills: ["skill-b"], commands: ["cmd-b"] });

    void mock.module("../config", () => ({
      getSettings: () => ({ jobsRepo: { url: "https://example.com/repo.git", branch: "main" } }),
      getJobsRepoDir: () => repoDir,
    }));

    const { discoverJobsRepoPlugins } = await import("../jobsRepoPlugins");
    const plugins = await discoverJobsRepoPlugins();

    expect(plugins).toHaveLength(2);
    // Sorted by dir (alphabetical)
    const names = plugins.map((p) => p.name).sort();
    expect(names).toContain("alpha-plugin");
    expect(names).toContain("beta-plugin");

    const alpha = plugins.find((p) => p.name === "alpha-plugin")!;
    expect(alpha.skills).toEqual(["skill-a"]);
    expect(alpha.commands).toEqual([]);

    const beta = plugins.find((p) => p.name === "beta-plugin")!;
    expect(beta.skills).toEqual(["skill-b"]);
    expect(beta.commands).toEqual(["cmd-b"]);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("discoverJobsRepoPlugins — falls back to basename when plugin.json has no name", async () => {
  const repoDir = await tmp();
  try {
    await initFakeGitRepo(repoDir);
    // Plugin with an empty manifest (no name field)
    await mkdir(join(repoDir, ".claude-plugin"), { recursive: true });
    await writeFile(join(repoDir, ".claude-plugin", "plugin.json"), "{}");

    void mock.module("../config", () => ({
      getSettings: () => ({ jobsRepo: { url: "https://example.com/repo.git", branch: "main" } }),
      getJobsRepoDir: () => repoDir,
    }));

    const { discoverJobsRepoPlugins } = await import("../jobsRepoPlugins");
    const plugins = await discoverJobsRepoPlugins();

    expect(plugins).toHaveLength(1);
    // basename of repoDir (a tmpdir name like "ccplugins-XXXXXX")
    expect(plugins[0].name).toBe(basename(repoDir));
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("getJobsRepoSpawnArgs — plugins found → --plugin-dir per plugin", async () => {
  const repoDir = await tmp();
  try {
    await initFakeGitRepo(repoDir);
    await makePlugin(repoDir, { name: "my-tools", skills: ["check"] });

    void mock.module("../config", () => ({
      getSettings: () => ({ jobsRepo: { url: "https://example.com/repo.git", branch: "main" } }),
      getJobsRepoDir: () => repoDir,
    }));

    const { getJobsRepoSpawnArgs } = await import("../jobsRepoPlugins");
    const args = await getJobsRepoSpawnArgs();

    expect(args).toContain("--plugin-dir");
    expect(args).toContain(repoDir);
    expect(args.length).toBe(2);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("getJobsRepoSpawnArgs — skills-only no manifest → --add-dir", async () => {
  const repoDir = await tmp();
  try {
    await initFakeGitRepo(repoDir);
    // No .claude-plugin/plugin.json — just a skills directory
    await mkdir(join(repoDir, ".claude", "skills", "my-skill"), { recursive: true });
    await writeFile(join(repoDir, ".claude", "skills", "my-skill", "SKILL.md"), "# my-skill\n");

    void mock.module("../config", () => ({
      getSettings: () => ({ jobsRepo: { url: "https://example.com/repo.git", branch: "main" } }),
      getJobsRepoDir: () => repoDir,
    }));

    const { getJobsRepoSpawnArgs } = await import("../jobsRepoPlugins");
    const args = await getJobsRepoSpawnArgs();

    expect(args).toEqual(["--add-dir", repoDir]);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("getJobsRepoSpawnArgs — neither plugins nor .claude/skills → []", async () => {
  const repoDir = await tmp();
  try {
    await initFakeGitRepo(repoDir);
    // Nothing special in the repo

    void mock.module("../config", () => ({
      getSettings: () => ({ jobsRepo: { url: "https://example.com/repo.git", branch: "main" } }),
      getJobsRepoDir: () => repoDir,
    }));

    const { getJobsRepoSpawnArgs } = await import("../jobsRepoPlugins");
    const args = await getJobsRepoSpawnArgs();

    expect(args).toEqual([]);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("getJobsRepoSpawnArgs — unconfigured jobs repo → []", async () => {
  void mock.module("../config", () => ({
    getSettings: () => ({ jobsRepo: { url: "", branch: "main" } }),
    getJobsRepoDir: () => "/nonexistent/path",
  }));

  const { getJobsRepoSpawnArgs } = await import("../jobsRepoPlugins");
  const args = await getJobsRepoSpawnArgs();

  expect(args).toEqual([]);
});

test("getJobsRepoSpawnArgs — two plugins → two --plugin-dir entries in sorted order", async () => {
  const repoDir = await tmp();
  try {
    await initFakeGitRepo(repoDir);
    const pluginsDir = join(repoDir, "plugins");
    await mkdir(join(pluginsDir, "aaa"), { recursive: true });
    await mkdir(join(pluginsDir, "zzz"), { recursive: true });
    await makePlugin(join(pluginsDir, "aaa"), { name: "aaa" });
    await makePlugin(join(pluginsDir, "zzz"), { name: "zzz" });

    void mock.module("../config", () => ({
      getSettings: () => ({ jobsRepo: { url: "https://example.com/repo.git", branch: "main" } }),
      getJobsRepoDir: () => repoDir,
    }));

    const { getJobsRepoSpawnArgs } = await import("../jobsRepoPlugins");
    const args = await getJobsRepoSpawnArgs();

    expect(args.length).toBe(4); // 2 x ("--plugin-dir" + path)
    expect(args[0]).toBe("--plugin-dir");
    expect(args[2]).toBe("--plugin-dir");
    // Both paths present
    expect(args).toContain(join(pluginsDir, "aaa"));
    expect(args).toContain(join(pluginsDir, "zzz"));
    // aaa comes before zzz (sorted by dir)
    expect(args.indexOf(join(pluginsDir, "aaa"))).toBeLessThan(
      args.indexOf(join(pluginsDir, "zzz"))
    );
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
