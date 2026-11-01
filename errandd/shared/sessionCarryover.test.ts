import { expect, test } from "bun:test";
import { sessionCarryoverEnvelope, splitSessionCarryover } from "./sessionCarryover";

test("generated carryover splits once and preserves the full suffix including code indentation", () => {
  const context = sessionCarryoverEnvelope(2, "Private model continuation state\n- Prior work");
  const message = "\n\n    indented user code\n## Incoming hook · cve";
  expect(splitSessionCarryover(context + message)).toEqual({ context, message });
});
test("ordinary messages, quoted envelopes and incomplete framing stay intact", () => {
  for (const text of ["ordinary user text", 'Example: <errandd-session-carryover generation="1">hello</errandd-session-carryover>', '<errandd-session-carryover generation="1">incomplete']) expect(splitSessionCarryover(text)).toBeNull();
});
