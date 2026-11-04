import { spawn } from "node:child_process";
import type { Job } from "./jobs";
import type { RunResult } from "./runner";

/** Trusted job configuration, like guard:, may run a bounded command without a model. */
export function runCommandJob(job: Pick<Job, "name" | "sourceDir" | "timeoutSeconds"> & { command: string },
  context: { repository?: string; prNumber?: number } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn("bash", ["-e", "-o", "pipefail", "-c", job.command], {
      cwd: job.sourceDir,
      env: { ...process.env, JOBS_SOURCE_DIR: job.sourceDir ?? process.cwd(),
        ERRANDD_REPOSITORY: context.repository ?? "", ERRANDD_PR_NUMBER: String(context.prNumber ?? "") },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", failure = "";
    const stop = (reason: string) => {
      failure ||= reason;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The process may have exited before its close event. */ }
    };
    const timer = setTimeout(() => stop("Command timed out"), Math.min(job.timeoutSeconds ?? 60, 600) * 1000);
    child.stdout.on("data", (data: Buffer) => {
      if (Buffer.byteLength(stdout) + data.length > 262_144) stop("Command output exceeded 256 KiB");
      else stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      if (Buffer.byteLength(stderr) + data.length > 262_144) stop("Command error output exceeded 256 KiB");
      else stderr += data.toString();
    });
    child.on("error", error => { failure = error.message; });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ exitCode: failure ? 1 : code ?? 1,
        stdout: `Deterministic job ${job.name} (no LLM interaction)\n${stdout}`,
        stderr: [stderr, failure].filter(Boolean).join("\n") });
    });
  });
}
