import { describe, test, expect } from "bun:test";
import { jobsRun } from "../ui/routes/jobs";
import type { RouteCtx } from "../ui/routes/types";
import type { RunJobNowResult, StartWebUiOptions } from "../ui/types";

/** Minimal RouteCtx for the handler under test. The dispatcher does host
 *  validation, CSRF and the bearer gate before a handler ever runs, so a
 *  handler test only needs the request, url and opts bag. */
function ctx(body: unknown, onRunJobNow?: StartWebUiOptions["onRunJobNow"]): RouteCtx {
  const url = new URL("http://localhost/api/jobs/run");
  return {
    req: new Request(url, { method: "POST", body: JSON.stringify(body) }),
    url,
    opts: {
      host: "127.0.0.1",
      port: 0,
      token: "t",
      getSnapshot: () => {
        throw new Error("unused");
      },
      ...(onRunJobNow ? { onRunJobNow } : {}),
    },
    sseResponse: () => new Response(null),
  };
}

describe("POST /api/jobs/run", () => {
  test("fires the named routine and reports the guard decision", async () => {
    const calls: { name: string; skipGuard?: boolean }[] = [];
    const res = await jobsRun(
      ctx({ name: "pr-automerge" }, (name, o) => {
        calls.push({ name, ...(o ?? {}) });
        return Promise.resolve<RunJobNowResult>({ ok: true, started: true, guard: "work" });
      }),
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true, started: true, guard: "work" });
    expect(calls).toEqual([{ name: "pr-automerge", skipGuard: false }]);
  });

  test("skipGuard rides through to the runner", async () => {
    let seen: boolean | undefined;
    await jobsRun(
      ctx({ name: "pr-automerge", skipGuard: true }, (_name, o) => {
        seen = o?.skipGuard;
        return Promise.resolve<RunJobNowResult>({ ok: true, started: true, guard: "bypassed" });
      }),
    );
    expect(seen).toBe(true);
  });

  test("a guard that finds no work is a 200 with started:false, not an error", async () => {
    const res = await jobsRun(
      ctx({ name: "pr-automerge" }, () =>
        Promise.resolve<RunJobNowResult>({
          ok: true,
          started: false,
          reason: "guard-no-work",
          guard: "no-work",
        }),
      ),
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ started: false, guard: "no-work" });
  });

  test("an unloaded routine is 404, not 500 — it's a bad name, not a daemon fault", async () => {
    const res = await jobsRun(
      ctx({ name: "nope" }, () =>
        Promise.resolve<RunJobNowResult>({ ok: false, started: false, reason: "not-loaded" }),
      ),
    );
    expect(res?.status).toBe(404);
    expect(await res?.json()).toMatchObject({ ok: false, reason: "not-loaded" });
  });

  test("no name is a 400 and never reaches the runner", async () => {
    let called = false;
    const res = await jobsRun(
      ctx({}, () => {
        called = true;
        return Promise.resolve<RunJobNowResult>({ ok: true, started: true });
      }),
    );
    expect(res?.status).toBe(400);
    expect(called).toBe(false);
  });

  test("501 when the daemon didn't wire a runner, so a caller can tell it apart from a bad name", async () => {
    const res = await jobsRun(ctx({ name: "pr-automerge" }));
    expect(res?.status).toBe(501);
  });
});
