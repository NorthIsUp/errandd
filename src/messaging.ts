/**
 * Extract a user-facing error detail from a Claude CLI run result.
 *
 * Claude CLI sometimes returns human-readable auth/quota failures in JSON
 * stdout instead of stderr. Prefer stderr when present, otherwise parse the
 * JSON stdout payload and fall back to raw stdout text.
 */
export function extractErrorDetail(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr?.trim() || "";
  if (stderr) return stderr;

  const stdout = result.stdout?.trim() || "";
  if (!stdout) return "";

  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      if (p.is_error && typeof p.result === "string") return p.result.trim();
      const err = p.error;
      if (typeof err === "object" && err !== null && "message" in err)
        return String((err as Record<string, unknown>).message).trim();
      if (typeof err === "string") return err.trim();
    }
  } catch {}

  return stdout;
}
