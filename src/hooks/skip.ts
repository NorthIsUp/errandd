import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDir } from "../../shared/claudeProjectDir";

/**
 * Write a synthetic Claude session JSONL for a config-driven skip — a hook
 * delivery the matcher decided NOT to run (self-skip, user/branch filter,
 * etc.). No Claude is spawned; we emit a single assistant turn carrying the
 * `[skip] …` marker, which the chat renders as a centered SystemBubble. The
 * caller registers the session and stamps trigger / payload / result.
 *
 * Returns the generated session UUID.
 */
export async function writeStaticSkipSession(args: { assistantText: string }): Promise<string> {
  const sessionId = crypto.randomUUID();
  const projectDir = claudeProjectDir();
  await mkdir(projectDir, { recursive: true });
  const filePath = join(projectDir, `${sessionId}.jsonl`);

  const timestamp = new Date().toISOString();
  const assistantEntry = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: args.assistantText }],
    },
    uuid: crypto.randomUUID(),
    timestamp,
    sessionId,
    cwd: process.cwd(),
  };
  await writeFile(filePath, `${JSON.stringify(assistantEntry)}\n`);
  return sessionId;
}
