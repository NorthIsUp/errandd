import { beforeEach, describe, expect, test } from "bun:test";
import { __resetHealthForTest, isReady, setReady } from "../health";

// Module state is shared across test files in one `bun test` process, so reset it
// — health-web-bundle.test.ts flips the web-bundle requirement.
beforeEach(() => {
  __resetHealthForTest();
});

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
