import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatExamples } from "../../../shared/chatExamples";

// Captures are local private state, never compiled into a public/static bundle.
export const CHAT_EXAMPLES_FILE = join(process.cwd(), ".claude/errandd/demos/chat-examples.json");
export async function readChatExamples(file = CHAT_EXAMPLES_FILE): Promise<ChatExamples | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ChatExamples;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
