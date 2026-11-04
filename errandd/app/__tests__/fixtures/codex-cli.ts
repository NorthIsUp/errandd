import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const capture = process.env.ERRANDD_TEST_CODEX_CAPTURE;
if (!capture) throw new Error("ERRANDD_TEST_CODEX_CAPTURE is required");
const prompt = args.at(-1) ?? "";
const resumeIndex = args.indexOf("resume");
let calls = 0;
try { calls = readFileSync(capture, "utf8").trim().split("\n").length; } catch { /* First invocation. */ }
appendFileSync(capture, JSON.stringify({ args, cwd: process.cwd(), authMatches: process.env.CODEX_API_KEY === "codex-test-key" }) + "\n");
if (!args.includes('approval_policy="never"') || !args.includes('sandbox_mode="danger-full-access"') || args.includes("features.shell_tool=false")) {
  console.error("Codex trust configuration missing");
  process.exit(64);
}
if (resumeIndex >= 0 && args[resumeIndex + 1] === "missing-session") {
  console.error("No saved session found: missing-session");
  process.exit(1);
}
if (prompt === "fixture-failure") {
  console.error("fixture child failed");
  process.exit(7);
}
if (prompt === "fixture-rate-limit") {
  console.error("rate limit exceeded");
  process.exit(1);
}
if (prompt === "fixture-timeout") await Bun.sleep(60_000);
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : `fixture-session-${calls}`;
if (args.includes("--json")) {
  for (const event of [
    { type: "thread.started", thread_id: sessionId },
    { type: "item.completed", item: { id: "tool", type: "command_execution", command: "echo fixture", aggregated_output: "fixture", exit_code: 0 } },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text: "fixture reply" } },
    { type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 } },
  ]) console.log(JSON.stringify(event));
} else console.log("fixture reply");
