import { expect, test } from "bun:test";
import { cveStatusMatches } from "./cveSubscriptions";

test("not-affected decisions are completed resolutions and retain their reason filter", () => {
  const legacy = { status: "not_affected" as const };
  for (const filter of ["resolved", "not_affected", "all"]) expect(cveStatusMatches(legacy, filter)).toBe(true);
  expect(cveStatusMatches(legacy, "affected")).toBe(false);
  const fixed = { status: "resolved" as const };
  expect(cveStatusMatches(fixed, "resolved")).toBe(true);
  expect(cveStatusMatches(fixed, "not_affected")).toBe(false);
});
