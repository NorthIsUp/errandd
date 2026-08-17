import { describe, expect, test } from "bun:test";
import type { McpServerSpec } from "../config";
import { resolveMcpServers, selectRegisterable } from "../mcpRegister";

/** The real deployment's server list, as ported out of start-errandd.sh. */
const SPECS: McpServerSpec[] = [
  {
    name: "litellm-gateway",
    transport: "http",
    target: "https://mcp.raccoon-fish.ts.net/mcp/",
    headers: ["Authorization: Bearer ${LITELLM_MCP_MASTER_KEY}"],
    requireEnv: ["LITELLM_MCP_MASTER_KEY"],
  },
  {
    name: "linear",
    transport: "http",
    target: "https://mcp.linear.app/mcp",
    headers: ["Authorization: Bearer ${LINEAR_TOKEN}"],
    requireEnv: ["LINEAR_TOKEN"],
  },
  {
    name: "sentry",
    transport: "stdio",
    target: `bash -c 'SENTRY_ACCESS_TOKEN="$SENTRY_AUTH_TOKEN" exec sentry-mcp'`,
    requireEnv: ["SENTRY_AUTH_TOKEN"],
  },
  {
    name: "github_extensions",
    transport: "stdio",
    target: `bash -c 'GITHUB_TOKEN="$(gh auth token)" exec uvx github-mcp-extensions'`,
    requireCommand: "uvx",
  },
  { name: "context7", transport: "http", target: "https://mcp.context7.com/mcp" },
];

const ALL_PRESENT = () => true;
const NONE_PRESENT = () => false;

describe("selectRegisterable", () => {
  test("with every credential and binary present, everything registers", () => {
    const { register, skipped } = selectRegisterable(
      SPECS,
      {
        LITELLM_MCP_MASTER_KEY: "k",
        LINEAR_TOKEN: "t",
        SENTRY_AUTH_TOKEN: "s",
      },
      ALL_PRESENT,
    );
    expect(register.map((s) => s.name)).toEqual([
      "litellm-gateway",
      "linear",
      "sentry",
      "github_extensions",
      "context7",
    ]);
    expect(skipped).toEqual([]);
  });

  test("a missing credential skips only its own server", () => {
    const { register, skipped } = selectRegisterable(
      SPECS,
      { LITELLM_MCP_MASTER_KEY: "k" },
      ALL_PRESENT,
    );
    expect(register.map((s) => s.name)).toEqual([
      "litellm-gateway",
      "github_extensions",
      "context7",
    ]);
    expect(skipped.map((s) => s.name)).toEqual(["linear", "sentry"]);
    expect(skipped[0]?.reason).toContain("LINEAR_TOKEN");
  });

  test("an empty-string credential counts as missing (a blank Secret is not a token)", () => {
    const { register } = selectRegisterable(SPECS, { LINEAR_TOKEN: "   " }, ALL_PRESENT);
    expect(register.map((s) => s.name)).not.toContain("linear");
  });

  test("a missing binary skips that server", () => {
    const { register, skipped } = selectRegisterable(SPECS, {}, NONE_PRESENT);
    expect(register.map((s) => s.name)).toEqual(["context7"]);
    expect(skipped.find((s) => s.name === "github_extensions")?.reason).toContain("uvx");
  });

  test("an explicit enabled:false wins over satisfied requirements", () => {
    const { register, skipped } = selectRegisterable(
      [{ name: "context7", transport: "http", target: "https://x", enabled: false }],
      {},
      ALL_PRESENT,
    );
    expect(register).toEqual([]);
    expect(skipped[0]?.reason).toBe("disabled");
  });

  test("a server with no requirements always registers", () => {
    const { register } = selectRegisterable(
      [{ name: "context7", transport: "http", target: "https://x" }],
      {},
      NONE_PRESENT,
    );
    expect(register.map((s) => s.name)).toEqual(["context7"]);
  });

  test("a spec list with no requirements at all still registers", () => {
    expect(selectRegisterable([], {}, ALL_PRESENT).register).toEqual([]);
  });

  test("literal ${VAR} in headers is preserved, not expanded", () => {
    // The CLI expands these at launch so the secret never lands in ~/.claude.json.
    const { register } = selectRegisterable(SPECS, { LINEAR_TOKEN: "real-secret" }, ALL_PRESENT);
    const linear = register.find((s) => s.name === "linear");
    expect(linear?.headers?.[0]).toBe("Authorization: Bearer ${LINEAR_TOKEN}");
    expect(linear?.headers?.[0]).not.toContain("real-secret");
  });
});

describe("resolveMcpServers", () => {
  const fromSettings: McpServerSpec[] = [
    { name: "from-settings", transport: "http", target: "https://s" },
  ];

  test("settings are used when no env override is present", () => {
    expect(resolveMcpServers(fromSettings, {}).map((s) => s.name)).toEqual(["from-settings"]);
  });

  test("ERRANDD_MCP_SERVERS wins — a GitOps manifest can declare the list", () => {
    const env = {
      ERRANDD_MCP_SERVERS: JSON.stringify([
        { name: "from-env", transport: "http", target: "https://e" },
      ]),
    };
    expect(resolveMcpServers(fromSettings, env).map((s) => s.name)).toEqual(["from-env"]);
  });

  test("malformed JSON falls back to settings rather than taking the daemon down", () => {
    expect(
      resolveMcpServers(fromSettings, { ERRANDD_MCP_SERVERS: "{not json" }).map((s) => s.name),
    ).toEqual(["from-settings"]);
  });

  test("a non-array env value falls back to settings", () => {
    expect(
      resolveMcpServers(fromSettings, { ERRANDD_MCP_SERVERS: '{"a":1}' }).map((s) => s.name),
    ).toEqual(["from-settings"]);
  });

  test("entries missing name/target are dropped, the rest survive", () => {
    const env = {
      ERRANDD_MCP_SERVERS: JSON.stringify([
        { name: "good", transport: "http", target: "https://g" },
        { name: "no-target" },
        { target: "https://no-name" },
      ]),
    };
    expect(resolveMcpServers(undefined, env).map((s) => s.name)).toEqual(["good"]);
  });

  test("nothing configured anywhere ⇒ empty (register nothing, touch nothing)", () => {
    expect(resolveMcpServers(undefined, {})).toEqual([]);
  });
});
