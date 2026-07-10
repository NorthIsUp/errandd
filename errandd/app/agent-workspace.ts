// Agent working-directory resolution, project CLAUDE.md management, and prompt
// loading. Extracted from runner.ts — behavior-preserving.

import { existsSync } from "fs";
import { mkdir, readFile, realpath, writeFile } from "fs/promises";
import { join, resolve, sep } from "path";

const PROJECT_DIR = process.cwd();

// Resolve prompts relative to the errandd installation, not the project dir
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const HEARTBEAT_PROMPT_FILE = join(PROMPTS_DIR, "heartbeat", "HEARTBEAT.md");
// Project-level prompt overrides live here (gitignored, user-owned)
const PROJECT_PROMPTS_DIR = join(process.cwd(), ".claude", "errandd", "prompts");
const PROJECT_CLAUDE_MD = join(process.cwd(), "CLAUDE.md");
const LEGACY_PROJECT_CLAUDE_MD = join(process.cwd(), ".claude", "CLAUDE.md");
const ERRANDD_BLOCK_START = "<!-- errandd:managed:start -->";
const ERRANDD_BLOCK_END = "<!-- errandd:managed:end -->";

/** Absolute path to the project's CLAUDE.md (read on every spawn). */
export const PROJECT_CLAUDE_MD_PATH = PROJECT_CLAUDE_MD;

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const rawMsg = (error as { message?: unknown }).message;
  const message = typeof rawMsg === "string" ? rawMsg : "";
  return /enoent|no such file or directory/i.test(message);
}

// Converts a raw agent/thread display name to a safe filesystem segment.
// Converts a display name to a safe filesystem segment (no unique suffix).
// Exported for display-only use (e.g. showing the human-readable name in UI).
export function safeAgentSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug) throw new Error(`Agent name "${raw}" cannot be converted to a safe path segment`);
  return slug;
}

// Builds a guaranteed-unique, filesystem-safe directory key for an agent thread.
// Truncates the display slug to leave room for "-<threadId>" so the suffix is
// NEVER truncated away on a second slugging pass.
export function agentDirKey(rawName: string, threadId: string): string {
  const suffix = `-${threadId}`;
  const maxSlugLen = Math.max(1, 64 - suffix.length);
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxSlugLen);
  if (!slug) throw new Error(`Agent name "${rawName}" cannot be converted to a safe path segment`);
  return `${slug}${suffix}`;
}

// Returns the working directory for a named agent's Claude spawn.
// Works with any agent name — Discord-generated keys (from agentDirKey) or
// raw filesystem directory names used by scheduled jobs.
// Security: uses realpath() after mkdir so symlinks are resolved before the
// containment check. A lexical path.resolve() check is not sufficient because
// a symlinked agents/<name> can point outside the repo and pass lexical checks.
export async function ensureAgentDir(name: string): Promise<string> {
  const agentsRoot = join(PROJECT_DIR, "agents");
  const dir = join(agentsRoot, name);
  // Lexical pre-check: reject obvious traversal before touching the filesystem
  if (!resolve(dir).startsWith(resolve(agentsRoot) + sep)) {
    throw new Error(`Agent directory "${dir}" would escape the agents root — rejecting`);
  }
  await mkdir(dir, { recursive: true });
  // Post-mkdir realpath checks resolve symlinks at every level.
  // We verify two things:
  //   1. agents/ itself resolves inside PROJECT_DIR (catches a symlinked agents/ root)
  //   2. agents/<name> resolves inside agents/ (catches a symlinked individual agent dir)
  const realProjectDir = await realpath(PROJECT_DIR);
  const realRoot = await realpath(agentsRoot);
  const realDir = await realpath(dir);
  if (!realRoot.startsWith(realProjectDir + sep)) {
    throw new Error(`agents/ root "${realRoot}" resolves outside the project directory via symlink — rejecting`);
  }
  if (!realDir.startsWith(realRoot + sep)) {
    throw new Error(`Agent directory "${realDir}" resolves outside the agents root via symlink — rejecting`);
  }
  return realDir;
}

export const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

/** Load and concatenate all prompt files from the prompts/ directory. */
export async function loadPrompts(): Promise<string> {
  const selectedPromptFiles = [
    join(PROMPTS_DIR, "IDENTITY.md"),
    join(PROMPTS_DIR, "USER.md"),
    join(PROMPTS_DIR, "SOUL.md"),
  ];
  const parts: string[] = [];

  for (const file of selectedPromptFiles) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read prompt file ${file}:`, e);
    }
  }

  return parts.join("\n\n");
}

export async function ensureProjectClaudeMd(): Promise<void> {
  // Preflight-only initialization: never rewrite an existing project CLAUDE.md.
  if (existsSync(PROJECT_CLAUDE_MD)) return;

  const promptContent = (await loadPrompts()).trim();
  const managedBlock = [
    ERRANDD_BLOCK_START,
    promptContent,
    ERRANDD_BLOCK_END,
  ].join("\n");

  let content = "";

  if (existsSync(LEGACY_PROJECT_CLAUDE_MD)) {
    try {
      const legacy = await readFile(LEGACY_PROJECT_CLAUDE_MD, "utf8");
      content = legacy.trim();
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read legacy .claude/CLAUDE.md:`, e);
      return;
    }
  }

  const normalized = content.trim();
  const hasManagedBlock =
    normalized.includes(ERRANDD_BLOCK_START) && normalized.includes(ERRANDD_BLOCK_END);
  const managedPattern = new RegExp(
    `${ERRANDD_BLOCK_START}[\\s\\S]*?${ERRANDD_BLOCK_END}`,
    "m"
  );

  const merged = hasManagedBlock
    ? `${normalized.replace(managedPattern, managedBlock)}\n`
    : normalized
      ? `${normalized}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;

  try {
    await writeFile(PROJECT_CLAUDE_MD, merged, "utf8");
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to write project CLAUDE.md:`, e);
  }
}

/**
 * Load the heartbeat prompt template.
 * Project-level override takes precedence: place a file at
 * .claude/errandd/prompts/HEARTBEAT.md to fully replace the built-in template.
 */
export async function loadHeartbeatPromptTemplate(): Promise<string> {
  const projectOverride = join(PROJECT_PROMPTS_DIR, "HEARTBEAT.md");
  for (const file of [projectOverride, HEARTBEAT_PROMPT_FILE]) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) return content.trim();
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn(`[${new Date().toLocaleTimeString()}] Failed to read heartbeat prompt file ${file}:`, e);
      }
    }
  }
  return "";
}
