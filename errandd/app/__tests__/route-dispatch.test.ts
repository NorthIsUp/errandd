import { expect, test } from "bun:test";
import { dispatch } from "../ui/routes";
import type { RouteCtx } from "../ui/routes/types";

function context(path: string, method = "GET"): RouteCtx {
  return {
    req: new Request(`http://localhost${path}`, {
      method,
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
    url: new URL(`http://localhost${path}`),
    opts: { getSnapshot: () => ({ jobs: [] }) },
  } as unknown as RouteCtx;
}

test("gated self routes preserve exact-route and unknown-route behavior", async () => {
  const jobs = await dispatch(context("/api/jobs"));
  expect(jobs.status).toBe(200);
  expect(await jobs.json()).toEqual({ jobs: [] });
  expect((await dispatch(context("/api/not-a-route"))).status).toBe(404);
  expect((await dispatch(context("/api/v3/threads/foo/message", "GET"))).status).toBe(404);
  expect((await dispatch(context("/api/v3/threads/foo/message", "POST"))).status).toBe(400);
});
