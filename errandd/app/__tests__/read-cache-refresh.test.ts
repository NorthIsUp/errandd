import { expect, test } from "bun:test";
import { cachedRead, getReadCache, refreshCachedRead } from "../readCache";

test("plugin mutations refresh after older in-flight discovery and concurrent readers coalesce", async () => {
  let release!: (value: { enabled: boolean }) => void;
  let discoveries = 0;
  const discover = () => {
    discoveries++;
    return new Promise<{ enabled: boolean }>(resolve => { release = resolve; });
  };
  const first = cachedRead("refresh-test", "plugin", 60_000, discover);
  const second = cachedRead("refresh-test", "plugin", 60_000, discover);
  const afterEnable = refreshCachedRead("refresh-test", "plugin", async () => ({ enabled: true }));
  const afterDisable = refreshCachedRead("refresh-test", "plugin", async () => ({ enabled: false }));
  expect(discoveries).toBe(1);
  release({ enabled: false });
  expect(await first).toEqual({ enabled: false });
  expect(await second).toEqual({ enabled: false });
  expect(await afterEnable).toEqual({ enabled: true });
  await afterDisable;
  expect(getReadCache().get("refresh-test", "plugin")?.value).toEqual({ enabled: false });
});
