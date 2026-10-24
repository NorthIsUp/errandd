import { expect, test } from "bun:test";
import { sseResponse } from "../ui/server";

test("SSE reader cancellation releases its subscription exactly once", async () => {
  const abort = new AbortController();
  let cleaned = 0;
  const response = sseResponse(new Request("http://localhost/events", { signal: abort.signal }), (send) => {
    send({ type: "snapshot" });
    return () => { cleaned++; };
  });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: {"type":"snapshot"}');
  await reader.cancel();
  abort.abort();
  expect(cleaned).toBe(1);
});

test("already-aborted SSE requests never subscribe", async () => {
  const abort = new AbortController();
  abort.abort();
  let subscribed = false;
  const response = sseResponse(new Request("http://localhost/events", { signal: abort.signal }), () => {
    subscribed = true;
    return () => {};
  });
  expect((await response.body!.getReader().read()).done).toBe(true);
  expect(subscribed).toBe(false);
});

test("abort during SSE setup still cleans the returned subscription", async () => {
  const abort = new AbortController();
  let cleaned = 0;
  const response = sseResponse(new Request("http://localhost/events", { signal: abort.signal }), () => {
    abort.abort();
    return () => { cleaned++; };
  });
  expect((await response.body!.getReader().read()).done).toBe(true);
  expect(cleaned).toBe(1);
});
