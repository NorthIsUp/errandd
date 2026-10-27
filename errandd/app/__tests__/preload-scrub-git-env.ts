import { spawnSync } from "node:child_process";

// Git exports these to hooks so hook commands find the repo (githooks(5)); a test
// that runs git in a temp dir would inherit them and act on errandd's repo instead.
// `--local-env-vars` is git's own list of the repo-locating variables.
const local = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).stdout ?? "";
for (const name of local.split("\n")) {
  if (name.trim()) delete process.env[name.trim()];
}
