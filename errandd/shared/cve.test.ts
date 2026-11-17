import { expect, test } from "bun:test";
import { readCveWeaknesses } from "./cve";

test("readCveWeaknesses upper-cases ids, rejects non-CWE ids and dedupes by id (last wins)", () => {
  expect(
    readCveWeaknesses([
      "cwe-79",
      { cweId: "CWE-79", description: "Cross-site scripting" },
      "CWE-0",
      "NVD-CWE-noinfo",
      { cwe_id: "CWE-20" },
    ]),
  ).toEqual([{ id: "CWE-79", name: "Cross-site scripting" }, { id: "CWE-20" }]);
});
