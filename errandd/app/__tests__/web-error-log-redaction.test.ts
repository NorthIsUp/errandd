import { afterEach, expect, spyOn, test } from "bun:test";
import { startWebUi } from "../ui/server";
import type { WebServerHandle } from "../ui/types";

let handle: WebServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

test("a handler that throws answers 500 and never logs the request URL or its ?token=", async () => {
  const token = "SECRET-WEB-TOKEN-do-not-log";
  const port = 40000 + Math.floor(Math.random() * 20000);
  const logged: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "));
  });
  try {
    handle = startWebUi({
      host: "127.0.0.1",
      port,
      token,
      // Every /api/* request reads the snapshot during auth, so this throws inside the handler.
      getSnapshot: () => {
        throw new Error("snapshot not ready");
      },
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/usage?token=${token}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "internal error" });
  } finally {
    spy.mockRestore();
  }
  expect(logged.some((line) => line.includes("snapshot not ready"))).toBe(true);
  expect(logged.join("\n")).not.toContain(token);
  expect(logged.join("\n")).not.toContain("/api/usage");
});
