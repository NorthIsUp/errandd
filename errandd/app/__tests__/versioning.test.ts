import { expect, test } from "bun:test";
import { bumpVersion, parseBumpType } from "../../scripts/versioning";

test("release scripts share patch/minor/major rollover behavior", () => {
  expect(parseBumpType()).toBe("patch");
  expect(bumpVersion("1.9.8", "patch")).toBe("1.9.9");
  expect(bumpVersion("1.9.8", "minor")).toBe("1.10.0");
  expect(bumpVersion("1.9.8", "major")).toBe("2.0.0");
  expect(() => parseBumpType("prerelease")).toThrow("Unsupported bump type");
  expect(() => bumpVersion("1.2", "patch")).toThrow("Unsupported version format");
});
