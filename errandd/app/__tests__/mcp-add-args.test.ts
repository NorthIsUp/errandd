import { describe, expect, test } from "bun:test";
import { buildMcpAddArgs, type McpServer } from "../mcp";

/**
 * These guard the exact failure seen on the deployed daemon: three of five MCP
 * servers failed to register with `claude mcp add exited 1: error: unknown
 * option '-c'`, because the argv omitted the `--` separator and the CLI parsed
 * the server's own `bash -c` flag as its own.
 */
describe("buildMcpAddArgs — stdio", () => {
  const stdio = (target: string): McpServer => ({
    name: "sentry",
    scope: "user",
    transport: "stdio",
    target,
  });

  test("emits -- so a command carrying flags reaches the command, not claude", () => {
    const argv = buildMcpAddArgs(stdio(`bash -c 'exec sentry-mcp'`));
    expect(argv).toEqual(["add", "-s", "user", "sentry", "--", "bash", "-c", "exec sentry-mcp"]);
    // The separator must come after the name and before the command.
    expect(argv.indexOf("--")).toBeGreaterThan(argv.indexOf("sentry"));
    expect(argv.indexOf("--")).toBeLessThan(argv.indexOf("bash"));
  });

  test("the real deployed sentry target survives intact", () => {
    const target = `bash -c 'SENTRY_ACCESS_TOKEN="$SENTRY_AUTH_TOKEN" exec sentry-mcp'`;
    const argv = buildMcpAddArgs(stdio(target));
    expect(argv.slice(0, 5)).toEqual(["add", "-s", "user", "sentry", "--"]);
    // The quoted script stays ONE argv entry — splitting it would break the
    // env-var assignment the server depends on.
    expect(argv[6]).toBe("-c");
    expect(argv[7]).toBe('SENTRY_ACCESS_TOKEN="$SENTRY_AUTH_TOKEN" exec sentry-mcp');
    expect(argv).toHaveLength(8);
  });

  test("a bare command with no flags still works", () => {
    expect(buildMcpAddArgs(stdio("github-mcp-server stdio"))).toEqual([
      "add",
      "-s",
      "user",
      "sentry",
      "--",
      "github-mcp-server",
      "stdio",
    ]);
  });

  test("an empty stdio target is rejected rather than producing a broken argv", () => {
    expect(() => buildMcpAddArgs(stdio("   "))).toThrow(/at least a command/);
  });
});

describe("buildMcpAddArgs — http/sse", () => {
  test("http keeps --transport and passes headers through verbatim", () => {
    const argv = buildMcpAddArgs({
      name: "linear",
      scope: "user",
      transport: "http",
      target: "https://mcp.linear.app/mcp",
      headers: ["Authorization: Bearer ${LINEAR_TOKEN}"],
    });
    expect(argv).toEqual([
      "add",
      "-s",
      "user",
      "--transport",
      "http",
      "linear",
      "https://mcp.linear.app/mcp",
      "-H",
      "Authorization: Bearer ${LINEAR_TOKEN}",
    ]);
    // Unexpanded on purpose: the CLI resolves it at launch, which is what keeps
    // the token out of ~/.claude.json.
    expect(argv.at(-1)).toContain("${LINEAR_TOKEN}");
  });

  test("http does NOT get a -- separator (it would be read as the URL)", () => {
    const argv = buildMcpAddArgs({
      name: "context7",
      scope: "user",
      transport: "http",
      target: "https://mcp.context7.com/mcp",
    });
    expect(argv).not.toContain("--");
  });
});
