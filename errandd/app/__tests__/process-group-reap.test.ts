// Proves the mechanism behind the MCP-orphan fix actually works on this
// platform, without needing a real claude session: spawn a detached parent
// that forks a long-lived grandchild, kill the GROUP, and assert the
// grandchild dies too. Killing only the parent (the old behaviour) leaves it
// running and reparented to init — which is exactly the leak.
import { describe, expect, test } from "bun:test";
import { reapProcessGroup, signalProcessGroup } from "../claude-spawn";

/** True while a pid exists (signal 0 probes without delivering). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

// A parent that spawns a grandchild and prints its pid, then idles. The
// grandchild is what stands in for an MCP server.
const SCRIPT = `sleep 300 & echo $!; sleep 300`;

describe("process-group reaping", () => {
  test("killing the group takes down the grandchild, not just the child", async () => {
    const proc = Bun.spawn(["sh", "-c", SCRIPT], {
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });

    // First line of stdout is the grandchild's pid.
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const grandchild = Number(new TextDecoder().decode(value).trim().split("\n")[0]);
    void reader.cancel();

    expect(Number.isFinite(grandchild)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    expect(alive(proc.pid)).toBe(true);

    reapProcessGroup(proc, 200);

    expect(await until(() => !alive(proc.pid))).toBe(true);
    // The point of the whole change: the grandchild goes too.
    expect(await until(() => !alive(grandchild))).toBe(true);
  });

  test("killing ONLY the child orphans the grandchild — the bug being fixed", async () => {
    const proc = Bun.spawn(["sh", "-c", SCRIPT], {
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const grandchild = Number(new TextDecoder().decode(value).trim().split("\n")[0]);
    void reader.cancel();

    proc.kill("SIGKILL"); // what the code did before
    expect(await until(() => !alive(proc.pid))).toBe(true);
    // Still alive: this is the orphan that used to survive at ~500MB.
    expect(alive(grandchild)).toBe(true);

    signalProcessGroup(proc.pid, "SIGKILL"); // clean up after ourselves
    await until(() => !alive(grandchild));
  });

  test("signalling a group that is already gone reports false, does not throw", () => {
    expect(signalProcessGroup(999_999_9, "SIGTERM")).toBe(false);
  });

  test("refuses pids that would broadcast", () => {
    // -1 means "every process we have permission to signal". Never send that.
    expect(signalProcessGroup(1, "SIGKILL")).toBe(false);
    expect(signalProcessGroup(0, "SIGKILL")).toBe(false);
  });
});
