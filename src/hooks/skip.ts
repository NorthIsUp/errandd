/**
 * Server-side static skip evaluation for hook deliveries.
 *
 * Some skip rules in the routine prompt are pure functions of the payload
 * (bot users, PRs targeting `main`). Evaluating them in the daemon — before
 * spawning Claude — saves a full session per skipped delivery: no tokens,
 * no row on the Runs view that says "running" forever, and no agent
 * context required to detect the obvious case.
 *
 * The agent still owns the higher-level skip logic (state-based dedup,
 * "I already replied", "branch is rebasing", etc.) — anything that needs
 * the conversation history or external lookups stays in the routine
 * prompt. This file is only for the cheap up-front checks.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Job } from "../jobs";
import { matchesGlob } from "./match";

export interface StaticSkip {
  /** Short label for logs + delivery summaries — e.g. `bot user`. */
  reason: string;
  /** Full system message persisted as the assistant turn. MUST start with `[skip]`. */
  message: string;
}

/**
 * Returns a skip record when the delivery matches a server-side rule,
 * or null when the agent should be allowed to handle it.
 *
 * The self-skip path stays in the receiver — this function assumes it
 * already ran and is only called for non-self events.
 *
 * Skip rules respect the same `hookConfig.skipSelf` opt-out as the
 * existing self-skip path, so any job that opted out of self-skip also
 * gets the agent-evaluated behavior for these scope skips (no static
 * skip applied).
 */
export function staticSkipReason(
  event: string,
  payload: unknown,
  job: Job,
): StaticSkip | null {
  // Re-use the same opt-out as the existing self-skip path. Jobs that
  // set `skipSelf: false` explicitly want the agent to evaluate every
  // delivery; honor that.
  if (job.hookConfig?.skipSelf === false) return null;
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;

  const prNumber = readPrNumber(event, root);

  // 1. Bot users. Same `*[bot]` pattern the routine prompt uses.
  const actor = readActor(event, root);
  if (actor && matchesGlob("*[bot]", actor.toLowerCase())) {
    return {
      reason: "bot user",
      message: prNumber
        ? `[skip] PR #${prNumber}: triggered by bot user \`${actor}\``
        : `[skip] triggered by bot user \`${actor}\``,
    };
  }

  // 2. PR targets main (release / landing PRs). Only meaningful for the
  // PR-class events that actually carry a base ref.
  if (
    event === "pull_request" ||
    event === "pull_request_review" ||
    event === "pull_request_review_comment"
  ) {
    const baseRef = readPath(root, ["pull_request", "base", "ref"]);
    if (baseRef === "main") {
      return {
        reason: "PR targets main",
        message: prNumber
          ? `[skip] PR #${prNumber}: PR targets main (release/landing PR — reviewed by humans)`
          : `[skip] PR targets main (release/landing PR — reviewed by humans)`,
      };
    }
  }

  return null;
}

function readActor(event: string, root: Record<string, unknown>): string | null {
  // Comment-class events carry the commenter under comment.user.login or
  // review.user.login; everything else falls back to the top-level sender.
  if (event === "issue_comment" || event === "pull_request_review_comment") {
    const a = readPath(root, ["comment", "user", "login"]);
    if (a) return a;
  }
  if (event === "pull_request_review") {
    const a = readPath(root, ["review", "user", "login"]);
    if (a) return a;
  }
  return readPath(root, ["sender", "login"]);
}

function readPrNumber(event: string, root: Record<string, unknown>): number | null {
  const pr = root.pull_request;
  if (typeof pr === "object" && pr !== null) {
    const n = (pr as Record<string, unknown>).number;
    if (typeof n === "number") return n;
  }
  if (event === "issue_comment" && typeof root.issue === "object" && root.issue !== null) {
    const issue = root.issue as Record<string, unknown>;
    if (typeof issue.pull_request === "object" && issue.pull_request !== null) {
      const n = issue.number;
      if (typeof n === "number") return n;
    }
  }
  return null;
}

function readPath(obj: Record<string, unknown>, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : null;
}

/**
 * Write a synthetic Claude session JSONL containing exactly one user
 * turn (the trigger summary the runner would have built) and one
 * assistant turn (the skip message). The file mirrors the on-disk
 * shape the real runner produces so the existing Runs view + chat
 * detail rendering pick it up unchanged.
 *
 * Returns the generated session UUID so the caller can register it
 * with `createThreadSession` and stamp trigger/result metadata on it.
 */
export async function writeStaticSkipSession(args: {
  /** Kept for back-compat in the signature; ignored — see comment. */
  userText?: string;
  assistantText: string;
}): Promise<string> {
  const sessionId = crypto.randomUUID();
  const projectDir = join(homedir(), ".claude", "projects", sanitizeCwd(process.cwd()));
  await mkdir(projectDir, { recursive: true });
  const filePath = join(projectDir, `${sessionId}.jsonl`);

  const timestamp = new Date().toISOString();
  const assistantUuid = crypto.randomUUID();

  // Statically-skipped deliveries NEVER actually sent the trigger
  // summary to Claude. Writing a "user" turn would imply the model saw
  // a prompt and replied — misleading. We emit only the single
  // assistant turn carrying the `[skip] …` marker, which the chat
  // renders as a centered SystemBubble (no tail).
  //
  // `userText` is kept on the signature for back-compat with callers
  // that may still pass it; the JSONL writer ignores it.
  void args.userText;
  const assistantEntry = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: args.assistantText }],
    },
    uuid: assistantUuid,
    timestamp,
    sessionId,
    cwd: process.cwd(),
  };

  const lines = `${JSON.stringify(assistantEntry)}\n`;
  await writeFile(filePath, lines);
  return sessionId;
}

/** Mirror Claude Code's JSONL directory sanitizer (slashes/backslashes/dots → dashes). */
function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[/\\.]/g, "-");
}
