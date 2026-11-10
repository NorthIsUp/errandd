import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sandboxCommand } from "../runtime/sandbox";

const cfg = { warmPool: "claude-pool", namespace: "agents", context: "kind-dev" };
const dir = mkdtempSync(join(tmpdir(), "errandd-sandbox-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("claim targets the warm pool with a self-deleting lifetime; secrets stay out of argv", () => {
  const { argv, env } = sandboxCommand(
    ["/opt/bin/claude", "-p", "hi"],
    { ANTHROPIC_AUTH_TOKEN: "sk-secret", PATH: "/usr/bin", CLAUDE_X: "a\nb" },
    cfg,
    60_000,
    Date.parse("2026-11-10T00:00:00Z"),
  );
  expect(argv.slice(3)).toEqual(["errandd-sandbox", "claude", "-p", "hi"]);
  expect(argv.join(" ")).not.toContain("sk-secret");
  expect(JSON.parse(env.ERRANDD_SB_CLAIM ?? "")).toMatchObject({
    kind: "SandboxClaim",
    spec: {
      warmPoolRef: { name: "claude-pool" },
      lifecycle: { shutdownPolicy: "Delete", shutdownTime: "2026-11-10T00:01:00.000Z" },
    },
  });
  expect(env.ERRANDD_SB_ENV).toBe("ANTHROPIC_AUTH_TOKEN=sk-secret");
});

test("script claims, execs into the claimed pod with forwarded env, then deletes the claim", async () => {
  const log = join(dir, "kubectl.log");
  // Fake kubectl: logs each call; `exec` runs the in-pod command locally.
  writeFileSync(
    join(dir, "kubectl"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *" create "*) cat > /dev/null; echo sandboxclaim.extensions.agents.x-k8s.io/errandd-abc ;;
  *" get sandboxclaim"*) echo sb-1 ;;
  *" get sandboxes"*) echo pod-1 ;;
  *" exec "*) while [ "$1" != "--" ]; do shift; done; shift; exec "$@" ;;
esac
`,
  );
  writeFileSync(join(dir, "claude"), `#!/bin/sh\n[ "$1" = sleep ] && exec sleep 30\necho "token=$ANTHROPIC_AUTH_TOKEN args=$*"\n`);
  chmodSync(join(dir, "kubectl"), 0o755);
  chmodSync(join(dir, "claude"), 0o755);

  const { argv, env } = sandboxCommand(
    ["/opt/bin/claude", "-p", "hi there"],
    { ANTHROPIC_AUTH_TOKEN: "sk-secret", PATH: `${dir}:/usr/bin:/bin` },
    cfg,
    60_000,
  );
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out.trim()).toBe("token=sk-secret args=-p hi there");

  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls.map((c) => c.split(" ").slice(4, 6).join(" "))).toEqual([
    "create -f",
    "wait --for=condition=Ready",
    "get sandboxclaim.extensions.agents.x-k8s.io/errandd-abc",
    "get sandboxes.agents.x-k8s.io",
    "exec -i",
    "delete sandboxclaim.extensions.agents.x-k8s.io/errandd-abc",
  ]);
  expect(calls[4]).toContain("exec -i pod-1 --");
  expect(calls[0]).toStartWith("--context kind-dev -n agents");
});

test("SIGTERM kills the exec and still deletes the claim", async () => {
  const log = join(dir, "kubectl.log");
  rmSync(log, { force: true });
  const { argv, env } = sandboxCommand(["claude", "sleep"], { PATH: `${dir}:/usr/bin:/bin` }, cfg, 60_000);
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 50 && !readFileSync(log, { encoding: "utf8", flag: "a+" }).includes(" exec "); i++) {
    await Bun.sleep(50);
  }
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(143);
  expect(readFileSync(log, "utf8")).toContain("delete sandboxclaim.extensions.agents.x-k8s.io/errandd-abc");
});
