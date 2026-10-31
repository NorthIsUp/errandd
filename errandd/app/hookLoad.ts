import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

export interface HookLoadSample {
  at: number;
  memoryUsed: number;
  memoryLimit: number;
  cpuMicros: number;
  cpuCores: number;
}

export interface HookAdmissionStatus {
  mode: "fixed" | "load-based";
  ceiling: number;
  active: number;
  capacity: number;
  reason: string;
  memoryUsed: number | null;
  memoryLimit: number | null;
  cpuUtilization: number | null;
}

/** Container totals include model children and their tools, unlike process.memoryUsage(). */
export function readHookLoad(now = Date.now(), read: (path: string) => string = (path) => readFileSync(path, "utf8"), cores = availableParallelism()): HookLoadSample | null {
  try {
    const memoryLimit = Number(read("/sys/fs/cgroup/memory.max").trim());
    const memoryUsed = Number(read("/sys/fs/cgroup/memory.current").trim());
    const [quota, period] = read("/sys/fs/cgroup/cpu.max").trim().split(/\s+/);
    const cpuCores = quota === "max" ? cores : Number(quota) / Number(period);
    const stat = read("/sys/fs/cgroup/cpu.stat");
    const cpuMicros = Number(/^usage_usec\s+(\d+)$/m.exec(stat)?.[1]);
    if (![memoryLimit, memoryUsed, cpuCores, cpuMicros].every(Number.isFinite) ||
        memoryLimit <= 0 || memoryUsed < 0 || cpuCores <= 0 || cpuMicros < 0) return null;
    return { at: now, memoryUsed, memoryLimit, cpuMicros, cpuCores };
  } catch {
    return null;
  }
}

export class HookModelAdmission {
  private previous: HookLoadSample | null = null;
  private cpuUtilization: number | null = null;
  private lastAdmittedAt = Number.NEGATIVE_INFINITY;
  status: HookAdmissionStatus = { mode: "fixed", ceiling: 3, active: 0, capacity: 0, reason: "not sampled", memoryUsed: null, memoryLimit: null, cpuUtilization: null };

  capacity(active: number, ceiling: number, loadBased: boolean, sample: HookLoadSample | null, now = Date.now()): number {
    const max = Number.isFinite(ceiling) ? Math.max(1, Math.floor(ceiling)) : 1;
    let capacity = max;
    let reason = "fixed ceiling";
    if (loadBased) {
      const gib = 1024 ** 3;
      if (sample) {
        const elapsed = this.previous ? sample.at - this.previous.at : 0;
        if (this.previous && elapsed >= 1_000) {
          const used = sample.cpuMicros - this.previous.cpuMicros;
          this.cpuUtilization = used >= 0 ? used / (elapsed * 1_000 * sample.cpuCores) : null;
          this.previous = sample;
        } else this.previous ??= sample;
      }
      capacity = active;
      if (active >= max) reason = "ceiling reached";
      else if (now - this.lastAdmittedAt < 10_000) reason = "waiting for the last admission to settle";
      else if (!sample) {
        capacity = Math.min(max, Math.max(active, 1));
        reason = "resource readings unavailable; single-worker fallback";
      } else if (sample.memoryLimit - sample.memoryUsed < Math.max(gib, sample.memoryLimit * 0.15) + gib) {
        reason = "memory headroom low";
      } else if (this.cpuUtilization !== null && this.cpuUtilization >= 0.85) {
        reason = "CPU saturated";
      } else {
        capacity = Math.min(max, active + 1);
        reason = "headroom available; admit one job";
      }
    }
    this.status = { mode: loadBased ? "load-based" : "fixed", ceiling: max, active, capacity, reason,
      memoryUsed: sample?.memoryUsed ?? null, memoryLimit: sample?.memoryLimit ?? null, cpuUtilization: this.cpuUtilization };
    return capacity;
  }

  admitted(now = Date.now()): void { this.lastAdmittedAt = now; }
}

export const hookModelAdmission = new HookModelAdmission();
export function getHookAdmissionStatus(): HookAdmissionStatus { return hookModelAdmission.status; }
