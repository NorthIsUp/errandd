import { afterAll, describe, expect, mock, test } from "bun:test";
import { ApiError, apiJSON, NotAuthorizedError } from "./client";

const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
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
  if (originalLocation) {
    Object.defineProperty(globalThis, "location", originalLocation);
  } else {
    Reflect.deleteProperty(globalThis, "location");
  }
  if (originalStorage) {
    Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

describe("API errors", () => {
  test("preserves plaintext error responses", async () => {
    globalThis.fetch = mock(
      async () => new Response("upstream unavailable", { status: 502 }),
    ) as unknown as typeof fetch;
    const error = await apiJSON("/api/state").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).body).toBe("upstream unavailable");
  });
  test("preserves structured unauthorized errors", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "expired" }, { status: 401 }),
    ) as unknown as typeof fetch;
    const error = await apiJSON("/api/state").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotAuthorizedError);
    expect((error as ApiError).body).toEqual({ error: "expired" });
  });
});
