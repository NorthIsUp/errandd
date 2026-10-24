/** Build a pinned native extension for the host, without shipping foreign-arch binaries. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, copyFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "0.3.5";
const expected = "86fb7e77b2f5d2d5db43d17a35f9c1d0e1587719dd450bc1fb39e8d58ea48f65";
const response = await fetch(`https://github.com/phiresky/sqlite-zstd/archive/refs/tags/v${version}.tar.gz`);
if (!response.ok) throw new Error(`sqlite-zstd download failed: ${response.status}`);
const archive = new Uint8Array(await response.arrayBuffer());
if (createHash("sha256").update(archive).digest("hex") !== expected) throw new Error("sqlite-zstd source checksum mismatch");
const directory = await mkdtemp(join(tmpdir(), "errandd-sqlite-zstd-"));
async function run(args: string[]): Promise<void> {
  if (await Bun.spawn(args, { stdout: "inherit", stderr: "inherit" }).exited !== 0) throw new Error(`Failed: ${args[0]}`);
}
try {
  const tarball = join(directory, "source.tar.gz");
  await Bun.write(tarball, archive);
  await run(["tar", "-xzf", tarball, "-C", directory]);
  const source = join(directory, `sqlite-zstd-${version}`);
  await run(["cargo", "build", "--locked", "--release", "--features", "build_extension", "--manifest-path", join(source, "Cargo.toml")]);
  const target = join(import.meta.dir, "../.native");
  const name = `libsqlite_zstd.${process.platform === "darwin" ? "dylib" : "so"}`;
  await mkdir(target, { recursive: true });
  const staged = join(target, `${name}.${process.pid}.tmp`);
  await copyFile(join(source, "target/release", name), staged);
  await rename(staged, join(target, name));
  await copyFile(join(source, "LICENSE"), join(target, "LICENSE.sqlite-zstd"));
  console.log(`Installed sqlite-zstd ${version}: ${join(target, name)}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
