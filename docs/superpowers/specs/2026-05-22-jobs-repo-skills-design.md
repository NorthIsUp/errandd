# Jobs-Repo Skills — Loading Plugins From the Jobs Repo

**Date:** 2026-05-22
**Status:** Approved design — ready for implementation planning
**Branch:** continues on `feat/deployability-jobs-ux` (same PR)

## Goal

Make Claude Code skills/commands/agents/hooks that live in the jobs repo discoverable by the `claude` subprocesses the daemon spawns. The jobs repo becomes one versioned place that carries both the agent's schedule (job `.md` files) and the agent's capabilities (plugins). Also surface the discovered capabilities in the web UI.

## Background

`src/runner.ts` spawns headless `claude -p …` subprocesses for heartbeat runs, scheduled jobs, and chat/DM handling. Claude Code only discovers skills from `~/.claude/skills/`, the cwd's `.claude/skills/` (+ parents), installed plugin skills, and `.claude/skills/` inside any `--add-dir` directory. The jobs repo is cloned to `.claude/claudeclaw/jobs-repo` (see the deployability spec), which is on none of those paths — so skills shipped in the jobs repo are currently invisible to job runs.

Claude Code's `--plugin-dir <dir>` flag loads a local plugin directory for the lifetime of one invocation, with no install step and no marketplace. It is repeatable. It works in headless `-p` mode. This is the mechanism.

## Approach

When the jobs repo is configured and cloned, the daemon discovers every plugin inside it and appends a `--plugin-dir` flag per plugin to every `claude` spawn. A repo that ships skills without a plugin manifest falls back to `--add-dir`. claudeclaw also statically inspects each discovered plugin to list its skills and commands, and surfaces that in the web UI.

## Components

### 1. Plugin discovery & inspection — new module `src/jobsRepoPlugins.ts`

```ts
export interface JobsRepoPlugin {
  name: string;        // from .claude-plugin/plugin.json "name"
  dir: string;         // absolute path to the plugin directory
  skills: string[];    // skill names (skills/<name>/SKILL.md)
  commands: string[];  // command names (commands/<name>.md)
}
```

- `discoverJobsRepoPlugins(): Promise<JobsRepoPlugin[]>` — scans the cloned jobs repo for plugin directories. A plugin directory is one containing `.claude-plugin/plugin.json`. Scan locations (bounded — no deep recursion):
  - the repo root,
  - each immediate subdirectory of the repo root,
  - each immediate subdirectory of a `plugins/` folder if one exists.
  For each plugin directory found: read `plugin.json` for `name` (fall back to the directory basename if absent/invalid); list `skills/*/SKILL.md` for skill names; list `commands/*.md` for command names. Deduplicate by absolute `dir`. Returns `[]` when `jobsRepo.url` is unset or the clone is missing.
- `getJobsRepoSpawnArgs(): Promise<string[]>` — builds the spawn flags:
  - if `discoverJobsRepoPlugins()` returns one or more plugins → `["--plugin-dir", p.dir, …]` for each,
  - else if the repo root has a `.claude/skills/` directory → `["--add-dir", <repoRoot>]`,
  - else → `[]`.
  Returns `[]` whenever the jobs repo is unset/uncloned, so a deployment with no jobs repo is byte-identical to today.

These are cheap directory reads; they run per spawn so a freshly-pulled repo is reflected with no daemon restart.

### 2. Runner wiring — `src/runner.ts`

`runner.ts` assembles `claude` argument arrays at several spawn sites (`execClaude`'s primary `args`, the fallback `fallbackArgs`, the no-resume `freshArgs`/`freshFallbackArgs`, and `streamUserMessage`'s `args`). In each async spawn path, compute `const repoArgs = await getJobsRepoSpawnArgs();` once and include `...repoArgs` in every argument array built in that path, appended after the security args. The implementation plan enumerates the exact line ranges.

Scope: all spawns — heartbeat, scheduled jobs, and chat/Telegram/Discord/Slack handling.

### 3. API — `src/jobsRepo.ts` + `src/ui/server.ts`

- Extend `JobsRepoStatus` with `plugins: JobsRepoPlugin[]`.
- `getJobsRepoStatus()` calls `discoverJobsRepoPlugins()` and includes the result.
- The existing `GET /api/jobs/repo/status` and `GET /api/home` routes return it with no route changes.

### 4. UI — Jobs section + Home

- **Jobs section** (`src/ui/page/sections/jobs.ts` + `script.ts`): the repo-status area renders the capabilities readout — one line per plugin with its skill/command counts, e.g. `my-tools — 3 skills, 1 command`. When there are no plugins, render nothing extra (no empty box).
- **Home git-sync card** (`src/ui/page/sections/home.ts` + `script.ts`): add a compact `plugins: N` line when `N > 0`.

Both consume `repo.plugins` from the status payload they already fetch.

### 5. Slash commands in the chat input — `src/ui/page/sections/chats.ts` + `script.ts`

The web Chat input gains slash-command support so a jobs-repo plugin's commands can be invoked from chat.

- **Pass-through:** a chat message whose text begins with `/` is sent to the runner verbatim, exactly as any other message. The spawned `claude` receives `/command …` as its prompt and — because `--plugin-dir` loaded the plugin (component 2) — expands and runs it. No runner change is needed for this; it already passes the prompt through.
- **Autocomplete affordance:** when the chat input's text starts with `/`, show a small popover listing the discovered commands. The list is fed by `repo.plugins[].commands` (the same `/api/jobs/repo/status` payload the Chats section already has access to), each rendered in its invocation form (`/<command>`, or `/<plugin>:<command>` if Claude Code namespaces plugin commands — confirmed by the verification task). Arrow keys + Enter or click selects an entry and inserts it into the input. Filtering narrows as the user types. The popover only lists jobs-repo plugin commands — claudeclaw cannot enumerate built-in or personal commands — but the user can still type any `/command` manually.
- Empty/closed when there are no discovered commands or the input does not start with `/`.

## First implementation task: verify the flags

Before any wiring, confirm against the installed `claude` CLI:
1. `--plugin-dir` is the actual flag name and accepts a local directory.
2. Whether `claude` re-reads the plugin directory fresh on each invocation, or caches it (e.g. keyed by `plugin.json` `version`).
3. That a slash command passed as the headless prompt — `claude -p "/<command>" --plugin-dir <dir>` — actually expands and runs the command, and what invocation form plugin commands take (bare `/<command>` vs namespaced `/<plugin>:<command>`).

If `--plugin-dir` does not exist or behaves differently, fall back to `--add-dir <repoRoot>` as the primary mechanism (it loads `.claude/skills/` from the directory and is known to re-read disk). If headless slash-command invocation does not work, component 5's pass-through degrades to a plain prompt (no command expansion) and the autocomplete is dropped — record the finding either way in the implementation plan and adjust.

## Skill-update propagation (known behavior)

A skill change reaches a job run via: push to the jobs-repo remote → the daemon's periodic pull fast-forwards the clone → the next `claude` spawn passes `--plugin-dir` at the now-updated path. Latency ≈ one pull interval plus time-to-next-spawn; no daemon restart. The periodic pull is skipped while the working tree is dirty (the existing dirty-skip rule), so an un-synced local edit also blocks skill updates — this is existing, documented behavior.

If the first task finds that `claude` caches `--plugin-dir` by plugin version, document this constraint: a jobs repo must bump its `plugin.json` `version` when it changes a skill, or the cached copy is reused. `--add-dir` is the escape hatch since it re-reads disk unconditionally.

## Security

`--plugin-dir` loads the plugin's `hooks/` as well as its skills, and hooks run shell commands. The jobs repo is operator-controlled — the operator sets `jobsRepo.url` — which is the same trust boundary as the job prompts that already run with the agent's tools. Acceptable; no additional sandboxing. Stated here so it is a deliberate decision.

## Testing

`bun test` additions in `src/__tests__/jobsRepoPlugins.test.ts`, using temp directories:
- single plugin at the repo root → one `--plugin-dir`.
- multiple plugins under `plugins/` → one `--plugin-dir` per plugin, in order.
- repo with `.claude/skills/` and no manifest → `--add-dir <root>`.
- repo with neither → `[]`.
- `discoverJobsRepoPlugins()` extracts plugin name from `plugin.json` and the correct skill/command name lists.
- unconfigured jobs repo → `getJobsRepoSpawnArgs()` returns `[]`.

## Out of scope

- Listing skills/commands via the `claude` CLI at runtime (no headless command exists; static inspection is used instead).
- Auto-generating a `plugin.json` for a manifest-less repo (would dirty the git working tree and block pulls).
- Installing the jobs repo as a persistent marketplace plugin.
- Auto-bumping the jobs repo's plugin version.
