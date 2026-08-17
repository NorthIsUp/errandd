import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetHealthForTest,
  isReady,
  isWebBundleReady,
  notReadyReason,
  requireWebBundle,
  setReady,
  setWebBundleReady,
} from "../health";

beforeEach(() => {
  __resetHealthForTest();
});

describe("readiness without a web UI", () => {
  test("a --no-web daemon is ready on startup alone", () => {
    setReady(true);
    expect(isWebBundleReady()).toBe(true);
    expect(isReady()).toBe(true);
    expect(notReadyReason()).toBe("");
  });
});

describe("readiness with the web UI enabled", () => {
  test("startup alone is NOT ready — the bundle has to build first", () => {
    requireWebBundle();
    setReady(true);
    expect(isReady()).toBe(false);
    expect(notReadyReason()).toBe("web bundle not built");
  });

  test("ready once the build reports success", () => {
    requireWebBundle();
    setReady(true);
    setWebBundleReady(true);
    expect(isReady()).toBe(true);
    expect(notReadyReason()).toBe("");
  });

  test("a FAILED build keeps the instance out of the load balancer", () => {
    // The whole point: `bun install` failing must fail the pod rather than serve
    // a dashboard that 503s for the life of the deploy.
    requireWebBundle();
    setReady(true);
    setWebBundleReady(false);
    expect(isReady()).toBe(false);
    expect(notReadyReason()).toBe("web bundle not built");
  });

  test("shutdown wins over a built bundle", () => {
    requireWebBundle();
    setReady(true);
    setWebBundleReady(true);
    setReady(false);
    expect(isReady()).toBe(false);
    expect(notReadyReason()).toBe("starting up or shutting down");
  });

  test("a bundle that breaks after boot flips the instance un-ready", () => {
    requireWebBundle();
    setReady(true);
    setWebBundleReady(true);
    expect(isReady()).toBe(true);
    setWebBundleReady(false);
    expect(isReady()).toBe(false);
  });
});
