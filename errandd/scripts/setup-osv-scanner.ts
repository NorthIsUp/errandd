/** Install a checksum-pinned official scanner; never execute repository install scripts. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
const version = "v2.7.0";
const hashes: Record<string, string> = {
  darwin_arm64: "d4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b",
  darwin_amd64: "e82c5df7ab0a42dff29a1cd0660711447b56b4c0483ff66ad8634df10fd81a45",
  linux_arm64: "4061ef4c021ed3c47f203b818f337e351336cc5cd67c0274fc36bd1dfc728dd7",
  linux_amd64: "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b",
};
const target = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
if (!hashes[target]) throw Error(`Unsupported scanner platform: ${target}`);
const response = await fetch(
  `https://github.com/google/osv-scanner/releases/download/${version}/osv-scanner_${target}`,
  { signal: AbortSignal.timeout(120_000) },
);
if (!response.ok) throw Error(`Scanner download HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== hashes[target])
  throw Error("Scanner checksum mismatch");
const directory = join(import.meta.dir, "../.native");
mkdirSync(directory, { recursive: true });
const path = join(directory, "osv-scanner");
const staged = `${path}.${process.pid}.tmp`;
await Bun.write(staged, bytes);
chmodSync(staged, 0o755);
renameSync(staged, path);
console.info(`Installed OSV-Scanner ${version}`);
