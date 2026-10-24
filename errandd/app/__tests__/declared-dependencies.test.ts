import { expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { preProcessFile } from "typescript";

const root = join(import.meta.dir, "../..");
const builtins = new Set([...builtinModules, "bun"]);
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

test("source imports declare their own packages instead of relying on legacy UI transitives", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const declared = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.devDependencies),
  ]);
  const missing: string[] = [];
  for (const path of ["app", "web", "shared", "scripts", "tests"].flatMap((name) =>
    files(join(root, name)),
  )) {
    for (const item of preProcessFile(readFileSync(path, "utf8"), true, true).importedFiles) {
      const name = item.fileName;
      if (
        name.startsWith(".") ||
        name.startsWith("/") ||
        name.startsWith("node:") ||
        name.startsWith("bun:") ||
        builtins.has(name)
      )
        continue;
      const dependency = name.startsWith("@")
        ? name.split("/").slice(0, 2).join("/")
        : name.split("/")[0];
      if (dependency && !declared.has(dependency))
        missing.push(`${relative(root, path)}: ${dependency}`);
    }
  }
  expect([...new Set(missing)].sort()).toEqual([]);
});
