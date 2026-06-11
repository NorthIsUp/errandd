/** A short wall-clock stamp for log-line prefixes (`[3:04:05 PM]`). The single
 *  shared implementation — `start.ts` and `plugins.ts` both import it instead
 *  of each defining an identical local `ts()`. */
export function ts(): string {
  return new Date().toLocaleTimeString();
}
