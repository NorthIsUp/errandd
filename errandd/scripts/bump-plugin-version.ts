import { readFile, writeFile } from "node:fs/promises";
import { bumpVersion, parseBumpType } from "./versioning";

const PLUGIN_JSON = "../.claude-plugin/plugin.json";
async function main(): Promise<void> {
  const bumpType = parseBumpType(process.argv[2]);
  const raw = await readFile(PLUGIN_JSON, "utf8");
  const plugin = JSON.parse(raw) as { version?: string };

  if (typeof plugin.version !== "string" || plugin.version.trim() === "") {
    throw new Error(`${PLUGIN_JSON} is missing a valid version string.`);
  }

  const nextVersion = bumpVersion(plugin.version, bumpType);
  plugin.version = nextVersion;

  await writeFile(PLUGIN_JSON, `${JSON.stringify(plugin, null, 2)}\n`, "utf8");
  console.log(`${PLUGIN_JSON}: ${nextVersion}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
