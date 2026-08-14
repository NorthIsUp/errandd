/**
 * `errandd repair-cli [version]` — check the CLI, and reinstall it with bun
 * when it is broken.
 *
 * The recovery path for a corrupt/truncated `claude` binary, which otherwise
 * takes a human comparing file sizes on a pod to diagnose. Refuses to install
 * without disk headroom instead of writing another truncated file.
 */

import { checkCli } from "../cliHealth";
import { CLI_PACKAGE, defaultInstallRoot, freeBytesAt, installCli } from "../cliInstall";

export async function repairCli(args: string[] = []): Promise<void> {
  const version = args.find((a) => !a.startsWith("-"));
  const force = args.includes("--force");
  const root = defaultInstallRoot();

  const before = await checkCli();
  console.log(
    before.ok
      ? `cli: ok — ${before.version} (${before.executable})`
      : `cli: BROKEN — ${before.error}`,
  );
  if (before.ok && !force) {
    console.log("nothing to repair (pass --force to reinstall anyway)");
    return;
  }

  const free = freeBytesAt(root);
  console.log(
    `installing ${CLI_PACKAGE}${version ? `@${version}` : ""} into ${root} ` +
      `(${free === null ? "free space unknown" : `${(free / 1e9).toFixed(2)} GB free`})`,
  );
  const result = await installCli({ ...(version ? { version } : {}), root });
  if (!result.ok) {
    console.error(`repair failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`cli repaired: ${result.version} (${result.executable})`);
}
