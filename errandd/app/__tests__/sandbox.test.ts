import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseSandbox, sandboxCommand } from "../runtime/sandbox";
import { buildSandboxKit } from "../runtime/sandboxKit";

const cfg = { warmPool: "claude-pool", namespace: "agents", context: "kind-dev" };
const dir = mkdtempSync(join(tmpdir(), "errandd-sandbox-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Fake kubectl: logs each call; `exec` runs the in-pod command locally.
writeFileSync(
  join(dir, "kubectl"),
  `#!/bin/sh
printf "%s\\n" "$*" | head -n1 >> "${join(dir, "kubectl.log")}"
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

test("parseSandbox: warmPool required, namespace defaults, blank context omitted", () => {
  expect(parseSandbox(undefined)).toBeUndefined();
  expect(parseSandbox({ warmPool: "  " })).toBeUndefined();
  expect(parseSandbox({ warmPool: "p", context: " " })).toEqual({ warmPool: "p", namespace: "default" });
  expect(parseSandbox({ warmPool: "p", namespace: "ns", context: "c" })).toEqual({ warmPool: "p", namespace: "ns", context: "c" });
});

test("claim targets the warm pool with a self-deleting lifetime; secrets stay out of argv", () => {
  const { argv, env } = sandboxCommand(
    ["/opt/bin/claude", "-p", "hi"],
    { ANTHROPIC_AUTH_TOKEN: "sk-secret", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/Users/x/.claude", OTEL_SERVICE_NAME: "a\nb" },
    cfg,
    60_000,
    "",
    undefined,
    Date.parse("2026-11-10T00:00:00Z"),
  );
  expect(argv.slice(2)).toEqual(["claude", "-p", "hi"]);
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

  const { argv, env } = sandboxCommand(
    ["/opt/bin/claude", "-p", "hi there"],
    { ANTHROPIC_AUTH_TOKEN: "sk-secret", PATH: `${dir}:/usr/bin:/bin` },
    cfg,
    60_000,
    "/nowhere/on/pod",
  );
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out.trim()).toBe("token=sk-secret args=-p hi there");
  expect(await new Response(proc.stderr).text()).toContain("cwd /nowhere/on/pod not in pod");

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

function claudeDirFixture(): string {
  const d = mkdtempSync(join(tmpdir(), "errandd-claude-"));
  mkdirSync(join(d, "plugins/cache/m/on/1.0"), { recursive: true });
  mkdirSync(join(d, "plugins/cache/m/off/1.0"), { recursive: true });
  writeFileSync(join(d, "plugins/cache/m/on/1.0/SKILL.md"), "on");
  writeFileSync(join(d, "settings.json"), JSON.stringify({ enabledPlugins: { "on@m": true, "off@m": false } }));
  writeFileSync(join(d, "plugins/installed_plugins.json"), JSON.stringify({ plugins: {
    "on@m": [{ installPath: join(d, "plugins/cache/m/on/1.0") }],
    "off@m": [{ installPath: join(d, "plugins/cache/m/off/1.0") }],
  } }));
  return d;
}

test("kit: gh auth for every runtime; remote MCP + enabled plugins for claude only", () => {
  const claudeDir = claudeDirFixture();
  const mcp = [
    { name: "litellm", transport: "http" as const, target: "https://mcp/", headers: ["Authorization: Bearer ${KEY}"], requireEnv: ["KEY"] },
    { name: "missing", transport: "http" as const, target: "https://x/", requireEnv: ["NOPE"] },
    { name: "local", transport: "stdio" as const, target: "sentry-mcp" },
  ];
  const kit = buildSandboxKit("/usr/bin/claude", mcp, { KEY: "k-secret" }, claudeDir, "ghs_tok");
  expect(kit.env).toMatchObject({ GH_TOKEN: "ghs_tok", GIT_CONFIG_VALUE_0: "!gh auth git-credential", KEY: "k-secret" });
  expect(kit.args[0]).toBe("--mcp-config");
  expect(JSON.parse(kit.args[1] ?? "")).toEqual({
    mcpServers: { litellm: { type: "http", url: "https://mcp/", headers: { Authorization: "Bearer ${KEY}" } } },
  });
  expect(kit.paths).toEqual(["settings.json", "plugins/installed_plugins.json", "plugins/cache/m/on/1.0"]);

  const codex = buildSandboxKit("codex", mcp, { KEY: "k" }, claudeDir, null);
  expect(codex).toEqual({ env: {}, args: [], paths: [], claudeDir });
  rmSync(claudeDir, { recursive: true, force: true });
});

test("script ships enabled plugins into the pod and passes kit args/env to the CLI", async () => {
  const claudeDir = claudeDirFixture();
  const podHome = mkdtempSync(join(tmpdir(), "errandd-podhome-"));
  // Its own claude stub, ahead of the shared one on PATH, so other tests keep theirs.
  const bin = mkdtempSync(join(tmpdir(), "errandd-bin-"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "gh=$GH_TOKEN key=$KEY args=$*"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const kit = buildSandboxKit(
    "claude",
    [{ name: "litellm", transport: "http", target: "https://mcp/", requireEnv: ["KEY"] }],
    { KEY: "k-secret" },
    claudeDir,
    "ghs_tok",
  );
  const { argv, env } = sandboxCommand(["claude", "-p", "go"], { PATH: `${bin}:${dir}:/usr/bin:/bin`, HOME: podHome }, cfg, 60_000, "", kit);
  expect(argv.join(" ")).not.toContain("ghs_tok");
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain("gh=ghs_tok key=k-secret args=--mcp-config");
  expect(out).toContain("-p go");
  expect(existsSync(join(podHome, ".claude/plugins/cache/m/on/1.0/SKILL.md"))).toBe(true);
  expect(existsSync(join(podHome, ".claude/plugins/cache/m/off"))).toBe(false);
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(podHome, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});
