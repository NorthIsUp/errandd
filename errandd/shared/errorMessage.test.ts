import { describe, expect, test } from "bun:test";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  test("uses Error.message", () => expect(errorMessage(new TypeError("boom"))).toBe("boom"));
  test("stringifies non-Error throws", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ message: "not an Error" })).toBe("[object Object]");
  });
});
