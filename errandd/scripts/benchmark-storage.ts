/** Reproducible storage benchmark using synthetic turns, never personal chats. */
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "errandd-storage-bench-"));
process.env.CODEX_HOME = directory;
process.env.ERRANDD_READ_CACHE_PATH = join(directory, "cache.db");
const { parseTranscript, seedParser, getThreadParts } = await import("../app/ui/services/threadParts");
const { getReadCache } = await import("../app/readCache");
const sessionId = "f4af32ba-e5cc-4a85-a847-8c98bb314741";
const file = join(directory, "sessions", `rollout-${sessionId}.jsonl`);
await mkdir(join(directory, "sessions"));
const lines: string[] = [];
for (let i = 0; i < 2000; i++) {
  lines.push(JSON.stringify({ type: "user", message: { content: `Check deployment ${i}` } }));
  lines.push(JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "Check the branch and run its tests." },
    { type: "tool_use", name: "Bash", id: `call-${i}`, input: { command: `git show commit-${i}` } },
  ] } }));
  lines.push(JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: `call-${i}`, content: JSON.stringify({ index: i, tests: "passed", output: "deployment is healthy\n".repeat(50) }) },
  ] } }));
  lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Deployment ${i} is healthy.` }] } }));
}
await Bun.write(file, lines.join("\n") + "\n");
async function measure(task: () => Promise<unknown>) {
  const durations: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    await task();
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  return { medianMs: +durations[15].toFixed(2), p95Ms: +durations[28].toFixed(2) };
}
try {
  const baseline = await measure(async () => parseTranscript(await readFile(file, "utf-8")));
  const start = performance.now();
  const indexed = await seedParser(sessionId);
  const initialIndexMs = +(performance.now() - start).toFixed(2);
  const db = getReadCache().db;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = Bun.file(db.filename).size;
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='_zstd_configs'").get()) db.query("SELECT zstd_incremental_maintenance(NULL,1)").get();
  db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
  const page = await measure(() => getThreadParts(sessionId, 200, -1));
  const fullSnapshot = await measure(() => seedParser(sessionId));
  console.log(JSON.stringify({ synthetic: true, transcriptBytes: Bun.file(file).size, parts: indexed.parser.parts.length,
    oldReadAndParse: baseline, initialIndexMs, compressedSqlPage: page, compressedFullStreamSeed: fullSnapshot,
    databaseBytesBefore: before, databaseBytesAfter: Bun.file(db.filename).size }, null, 2));
} finally { getReadCache().close(); await rm(directory, { recursive: true, force: true }); }
