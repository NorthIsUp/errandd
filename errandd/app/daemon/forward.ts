import { extractErrorDetail } from "../messaging";

/**
 * The shared, pure body of the (formerly triplicated) forwardToTelegram /
 * forwardToDiscord / forwardToSlack helpers (codebase-audit P1). Builds the
 * exact text those three functions sent: on success, an optional `[label]\n`
 * prefix + stdout (or `(empty)`); on failure, an optional `[label] ` prefix +
 * `error (exit N): <detail>`. Behaviour-identical to each inline ternary.
 */
export function formatForwardText(
  label: string,
  result: { exitCode: number; stdout: string; stderr: string },
): string {
  return result.exitCode === 0
    ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
    : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${extractErrorDetail(result) || "Unknown"}`;
}
