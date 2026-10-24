import { afterAll, expect, mock, test } from "bun:test";
import { streamChat, type StreamChatCallbacks } from "./chat";

const originalFetch = globalThis.fetch;
const descriptors = ["location", "sessionStorage"].map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { href: "http://localhost/" },
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: { getItem: () => null },
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function respond(events: unknown[]): void {
  const wire = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  // Fragment inside both JSON and multibyte Unicode sequences.
  let offset = 0;
  globalThis.fetch = mock(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === wire.length) {
              controller.close();
              return;
            }
            controller.enqueue(wire.slice(offset, offset + 1));
            offset++;
          },
        }),
      ),
  ) as unknown as typeof fetch;
}
function callbacks() {
  const chunks: string[] = [];
  const done = mock(() => {});
  const error = mock((_err: Error) => {});
  const unblock = mock(() => {});
  const handlers: StreamChatCallbacks = {
    onChunk: (text) => chunks.push(text),
    onDone: done,
    onError: error,
    onUnblock: unblock,
  };
  return { chunks, done, error, unblock, handlers };
}

test("chat consumes fragmented AG-UI text, custom notifications and completion", async () => {
  respond([
    { type: "RUN_STARTED" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "Hello 🦞" },
    { type: "CUSTOM", name: "errandd.unblock", value: {} },
    { type: "RUN_FINISHED" },
  ]);
  const state = callbacks();
  await streamChat({ message: "hello" }, state.handlers);
  expect(state.chunks).toEqual(["Hello 🦞"]);
  expect(state.unblock).toHaveBeenCalledTimes(1);
  expect(state.done).toHaveBeenCalledTimes(1);
  expect(state.error).not.toHaveBeenCalled();
});

test("chat rejects an interrupted stream without a terminal event", async () => {
  respond([{ type: "TEXT_MESSAGE_CONTENT", delta: "partial" }]);
  const state = callbacks();
  await streamChat({ message: "hello" }, state.handlers);
  expect(state.error).toHaveBeenCalledTimes(1);
  expect(state.done).not.toHaveBeenCalled();
});

test("chat surfaces RUN_ERROR without calling onDone", async () => {
  respond([{ type: "RUN_ERROR", message: "rate limit" }]);
  const state = callbacks();
  await streamChat({ message: "hello" }, state.handlers);
  expect(state.error.mock.calls[0]?.[0].message).toBe("rate limit");
  expect(state.done).not.toHaveBeenCalled();
});
