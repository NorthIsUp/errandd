import { describe, expect, test } from "bun:test";
import { parsePs, selectOrphanedMcp, type ProcSnapshot } from "../mcpReaper";

/** Shaped like the real `ps -eo pid=,ppid=,etimes=,args=` output from the pod. */
const PS_OUTPUT = `
1176778     1     270 claude --remote-control claw
1177059 1176778   267 node /home/claude/.npm-global/bin/sentry-mcp
1182208     1     124 node /home/claude/.npm-global/bin/sentry-mcp
1183481     1      88 node /home/claude/.npm-global/bin/sentry-mcp
1185639 1185364     3 node /home/claude/.npm-global/bin/sentry-mcp
1185700     1     900 /usr/bin/tailscaled --state=/var/lib/tailscale
`;

function proc(p: Partial<ProcSnapshot>): ProcSnapshot {
  return { pid: 100, ppid: 1, ageSeconds: 300, command: "node sentry-mcp", ...p };
}

describe("parsePs", () => {
  test("parses pid/ppid/age/command", () => {
    const procs = parsePs(PS_OUTPUT);
    expect(procs).toHaveLength(6);
    expect(procs[0]).toEqual({
      pid: 1176778,
      ppid: 1,
      ageSeconds: 270,
      command: "claude --remote-control claw",
    });
  });

  test("ignores junk lines", () => {
    expect(parsePs("garbage\n\n  \nnot a row")).toEqual([]);
  });
});

describe("selectOrphanedMcp", () => {
  test("picks only init-parented MCP servers", () => {
    const picked = selectOrphanedMcp(parsePs(PS_OUTPUT), 999).map((p) => p.pid);
    // 1182208 + 1183481 are orphaned MCP servers.
    expect(picked).toEqual([1182208, 1183481]);
  });

  test("leaves MCP servers that still have a live session parent", () => {
    // 1177059's parent is the remote-control claude; 1185639's is a -p session.
    const picked = selectOrphanedMcp(parsePs(PS_OUTPUT), 999).map((p) => p.pid);
    expect(picked).not.toContain(1177059);
    expect(picked).not.toContain(1185639);
  });

  test("never touches non-MCP init children (e.g. tailscaled)", () => {
    const picked = selectOrphanedMcp(parsePs(PS_OUTPUT), 999).map((p) => p.pid);
    expect(picked).not.toContain(1185700);
  });

  test("respects the grace period — a just-reparented server is left alone", () => {
    expect(selectOrphanedMcp([proc({ pid: 5, ageSeconds: 10 })], 999)).toEqual([]);
    expect(selectOrphanedMcp([proc({ pid: 5, ageSeconds: 61 })], 999)).toHaveLength(1);
  });

  test("never targets the daemon itself or init", () => {
    expect(selectOrphanedMcp([proc({ pid: 42 })], 42)).toEqual([]);
    expect(selectOrphanedMcp([proc({ pid: 1 })], 999)).toEqual([]);
  });

  test("does not target the ps/grep pipeline that reports on MCP processes", () => {
    const procs = [
      proc({ pid: 7, command: "sh -c ps -eo pid,args | grep mcp" }),
      proc({ pid: 8, command: "ps -eo pid=,ppid=,etimes=,args=" }),
    ];
    expect(selectOrphanedMcp(procs, 999)).toEqual([]);
  });

  test("matches MCP servers regardless of vendor", () => {
    const procs = [
      proc({ pid: 11, command: "node /x/bin/sentry-mcp" }),
      proc({ pid: 12, command: "github-mcp-server stdio" }),
      proc({ pid: 13, command: "uvx github-mcp-extensions" }),
      proc({ pid: 14, command: "/usr/bin/postgres -D /data" }),
    ];
    expect(selectOrphanedMcp(procs, 999).map((p) => p.pid)).toEqual([11, 12, 13]);
  });
});
