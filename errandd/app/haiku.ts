/**
 * Haiku one-shot helpers.
 *
 * Provides a tiny wrapper around `claude -p` (print / non-interactive mode)
 * with the haiku model, plus a job-name generator that uses it.
 *
 * Intentionally isolated from runner.ts's session/threadId machinery — these
 * are stateless one-shots, not persistent daemon sessions.
 */
import { getRuntime } from "./runtime/select";

/**
 * Run a one-shot headless completion with the haiku model and return its
 * stdout text (trimmed).
 *
 * @throws if the process exits non-zero or the timeout fires.
 */
export async function runHaikuOneShot(
  prompt: string,
  timeoutMs = 30_000
): Promise<string> {
  return runModelOneShot(prompt, "haiku", timeoutMs);
}

/**
 * Run a one-shot headless completion with an arbitrary model and return its
 * stdout text (trimmed). No tools, no session — a pure text completion. Used by
 * the routine `filter_prompt` pre-check (default model `sonnet`).
 *
 * @throws if the process exits non-zero or the timeout fires.
 */
export async function runModelOneShot(
  prompt: string,
  model: string,
  timeoutMs = 30_000
): Promise<string> {
  const { stdout, exitCode, timedOut } = await getRuntime().runOneShot({
    prompt,
    model,
    outputMode: "text",
    timeoutMs,
  });

  if (timedOut) {
    throw new Error(`runHaikuOneShot timed out after ${timeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(`claude -p exited with code ${exitCode}`);
  }

  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Pure validation helpers (exported so they're testable without invoking Claude)
// ---------------------------------------------------------------------------

/** True when `s` is a valid generated kebab-case job filename (no extension). */
export function isValidGeneratedName(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s);
}

/** True when `filename` matches the date-stamp pattern used by + New. */
export function isDateFilename(filename: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(filename);
}

// ---------------------------------------------------------------------------
// Name generation
// ---------------------------------------------------------------------------

const GENERATE_PROMPT_PREFIX = `You are a file-naming assistant.
Given the content of a job file (a scheduled task definition), output a short kebab-case name for the file.

Rules:
- 3 to 4 words, joined with hyphens
- all lowercase letters, digits, and hyphens only
- no file extension
- no quotes, backticks, markdown, or any other commentary — ONLY the name on a single line

Example outputs:
check-disk-free
daily-slack-report
restart-stale-agents
sync-github-issues

Job file content:
`;

/**
 * Ask Claude Haiku for a pithy kebab-case filename based on job file content.
 *
 * @throws if the generated name fails validation.
 */
export async function generateJobName(content: string): Promise<string> {
  const prompt = GENERATE_PROMPT_PREFIX + content;
  const raw = await runHaikuOneShot(prompt);

  // Strip any accidental surrounding quotes/backticks and normalise whitespace
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/\s+.*/, "") // take only first word/token if model wrote more
    .trim();

  if (!isValidGeneratedName(cleaned)) {
    throw new Error(
      `generateJobName: invalid name from model: "${cleaned}" (raw: "${raw}")`
    );
  }

  return cleaned;
}
