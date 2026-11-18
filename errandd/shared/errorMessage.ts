/** Message of a caught value: `Error.message`, or `String(err)` for anything else thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
