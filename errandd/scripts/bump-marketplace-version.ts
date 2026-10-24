import { readFile, writeFile } from "node:fs/promises";
import { bumpVersion, parseBumpType } from "./versioning";

const MARKETPLACE_JSON = "../.claude-plugin/marketplace.json";
async function main(): Promise<void> {
  const bumpType = parseBumpType(process.argv[2]);
  const raw = await readFile(MARKETPLACE_JSON, "utf8");
  const marketplace = JSON.parse(raw) as { plugins?: { name?: string; version?: string }[] };

  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    throw new Error(`${MARKETPLACE_JSON} does not contain any plugins.`);
  }

  const plugin = marketplace.plugins.find((entry) => entry.name === "errandd") ?? marketplace.plugins[0];
  if (!plugin || typeof plugin.version !== "string" || plugin.version.trim() === "") {
    throw new Error(`${MARKETPLACE_JSON} is missing a valid plugin version string.`);
  }

  const nextVersion = bumpVersion(plugin.version, bumpType);
  plugin.version = nextVersion;

  await writeFile(MARKETPLACE_JSON, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
  console.log(`${MARKETPLACE_JSON}: ${nextVersion}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
