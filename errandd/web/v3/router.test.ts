import { describe, expect, test } from "bun:test";
import { formatRoute as formatLegacy, parse as parseLegacy } from "../ui/router";
import { formatRoute, parse } from "./router";

describe("hash routing", () => {
  test("round trips encoded thread IDs", () => {
    const id = "repo/branch:#42%done";
    expect(parse(formatRoute("chat", [id])).segments).toEqual([id]);
    expect(parseLegacy(formatLegacy("chat", [id])).segments).toEqual([id]);
  });
  test("malformed percent escapes do not crash either shell", () => {
    expect(parse("#/chat/broken%ZZ")).toEqual({ view: "chat", segments: ["broken%ZZ"] });
    expect(parseLegacy("#/runs/broken%E0%A4%A")).toEqual({
      tab: "runs",
      segments: ["broken%E0%A4%A"],
    });
  });
});
