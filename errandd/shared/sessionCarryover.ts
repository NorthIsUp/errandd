const CLOSE = "</errandd-session-carryover>";

export function sessionCarryoverEnvelope(generation: number, body: string): string {
  return `<errandd-session-carryover generation="${generation}">\n${body}\n${CLOSE}`;
}

/** Only strip the exact generated prefix; preserve the remaining message byte for byte. */
export function splitSessionCarryover(text: string): { context: string; message: string } | null {
  const opening = /^\s*<errandd-session-carryover generation="\d+">/.exec(text);
  if (!opening) return null;
  const end = text.indexOf(CLOSE, opening[0].length);
  return end < 0 ? null : { context: text.slice(0, end + CLOSE.length), message: text.slice(end + CLOSE.length) };
}
