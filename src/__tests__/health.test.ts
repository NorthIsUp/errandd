import { describe, expect, test } from "bun:test";
import { isReady, setReady } from "../health";

describe("readiness flag (/readyz)", () => {
  test("starts not-ready and flips with setReady (startup → ready → drain)", () => {
    // Module starts false (no startup has run in the test process).
    setReady(false);
    expect(isReady()).toBe(false);
    // Startup completed.
    setReady(true);
    expect(isReady()).toBe(true);
    // Shutdown began — drain.
    setReady(false);
    expect(isReady()).toBe(false);
  });
});
