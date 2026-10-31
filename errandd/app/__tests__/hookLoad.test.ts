import { expect, test } from "bun:test";
import { HookModelAdmission, readHookLoad, type HookLoadSample } from "../hookLoad";

const gib = 1024 ** 3;
const sample = (at: number, memoryUsed = 2 * gib, cpuMicros = 0): HookLoadSample => ({ at, memoryUsed, memoryLimit: 10 * gib, cpuMicros, cpuCores: 2 });

test("load-based admission grows one job at a time up to ten, allowing memory/CPU to settle", () => {
  const a = new HookModelAdmission();
  expect(a.capacity(0, 10, true, sample(1_000), 1_000)).toBe(1);
  a.admitted(1_000);
  expect(a.capacity(1, 10, true, sample(2_000), 2_000)).toBe(1);
  expect(a.status.reason).toContain("settle");
  expect(a.capacity(1, 10, true, sample(11_000), 11_000)).toBe(2);
  expect(a.capacity(9, 10, true, sample(21_000), 21_000)).toBe(10);
  expect(a.capacity(10, 10, true, sample(31_000), 31_000)).toBe(10);
});

test("memory pressure pauses starts without killing active jobs and recovers when pressure clears", () => {
  const a = new HookModelAdmission();
  expect(a.capacity(4, 10, true, sample(1_000, 8 * gib), 1_000)).toBe(4);
  expect(a.status.reason).toBe("memory headroom low");
  expect(a.capacity(4, 10, true, sample(11_000, 5 * gib), 11_000)).toBe(5);
  expect(a.capacity(0, 10, true, sample(21_000, 10 * gib), 21_000)).toBe(0);
});

test("CPU quota-normalized saturation pauses starts and a later idle sample resumes admission", () => {
  const a = new HookModelAdmission();
  a.capacity(2, 10, true, sample(1_000, 2 * gib, 0), 1_000);
  expect(a.capacity(2, 10, true, sample(2_000, 2 * gib, 1_900_000), 2_000)).toBe(2);
  expect(a.status.cpuUtilization).toBeCloseTo(0.95);
  expect(a.status.reason).toBe("CPU saturated");
  expect(a.capacity(2, 10, true, sample(3_000, 2 * gib, 2_000_000), 3_000)).toBe(3);
});

test("unavailable metrics use a conservative single-worker fallback; fixed mode preserves its configured ceiling", () => {
  const a = new HookModelAdmission();
  expect(a.capacity(0, 10, true, null, 1_000)).toBe(1);
  expect(a.capacity(3, 10, true, null, 2_000)).toBe(3);
  expect(a.capacity(3, 10, false, null, 3_000)).toBe(10);
  expect(a.status.mode).toBe("fixed");
});

test("container readings parse cgroup memory and CPU quota rather than using node-wide free memory", () => {
  const values: Record<string, string> = {
    "/sys/fs/cgroup/memory.max": String(10 * gib),
    "/sys/fs/cgroup/memory.current": String(3 * gib),
    "/sys/fs/cgroup/cpu.max": "200000 100000\n",
    "/sys/fs/cgroup/cpu.stat": "usage_usec 123456\nuser_usec 100000\n",
  };
  const read = (path: string): string => values[path];
  expect(readHookLoad(1_000, read, 64)).toEqual({ at: 1_000, memoryUsed: 3 * gib, memoryLimit: 10 * gib, cpuCores: 2, cpuMicros: 123456 });
  for (const path of Object.keys(values)) {
    const original = values[path]; values[path] = "unavailable";
    expect(readHookLoad(1_000, read, 64)).toBeNull();
    values[path] = original;
  }
  expect(readHookLoad(1_000, () => { throw new Error("not Linux"); })).toBeNull();
});
