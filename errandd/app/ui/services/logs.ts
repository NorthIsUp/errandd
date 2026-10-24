import { open, readdir, stat } from "fs/promises";
import { join } from "path";
import { LOGS_DIR } from "../constants";

export async function readLogs(tail: number) {
  const daemonLog = await readTail(join(LOGS_DIR, "daemon.log"), tail);
  const runs = await readRecentRunLogs(tail);
  return { daemonLog, runs };
}

async function readRecentRunLogs(tail: number) {
  const files = await readdir(LOGS_DIR).catch(() => null);
  if (files === null) return [];

  const candidates = files.filter((f) => f.endsWith(".log") && f !== "daemon.log");

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const path = join(LOGS_DIR, name);
      try {
        const s = await stat(path);
        return { name, path, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  return await Promise.all(
    withStats
      .filter((x): x is { name: string; path: string; mtime: number } => Boolean(x))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5)
      .map(async ({ name, path, mtime }) => ({
        file: name,
        mtime,
        lines: await readTail(path, tail),
      })),
  );
}

async function readTail(path: string, lines: number): Promise<string[]> {
  try {
    const file = await open(path, "r");
    try {
      let position = (await file.stat()).size;
      const chunks: Buffer[] = [];
      let newlines = 0;
      while (position > 0 && newlines <= lines) {
        const length = Math.min(position, 64 * 1024);
        position -= length;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, position);
        const chunk = buffer.subarray(0, bytesRead);
        for (const byte of chunk) if (byte === 10) newlines++;
        chunks.unshift(chunk);
      }
      const all = Buffer.concat(chunks).toString("utf-8").split(/\r?\n/);
      return all.slice(Math.max(0, all.length - lines)).filter(Boolean);
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
}
