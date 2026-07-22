import { expect, test } from "bun:test";
import { outputStyleArgs } from "../spawn-config";

test("empty / whitespace / undefined -> no args (inherit CLI default)", () => {
  expect(outputStyleArgs("")).toEqual([]);
  expect(outputStyleArgs("   ")).toEqual([]);
  expect(outputStyleArgs(undefined)).toEqual([]);
});

test("a style name -> --settings with trimmed outputStyle JSON", () => {
  expect(outputStyleArgs("Explanatory")).toEqual([
    "--settings",
    '{"outputStyle":"Explanatory"}',
  ]);
  // Trims surrounding whitespace before serializing.
  expect(outputStyleArgs("  Learning  ")).toEqual([
    "--settings",
    '{"outputStyle":"Learning"}',
  ]);
});
