import { describe, expect, test } from "bun:test";
import { parseDaemonPid } from "../pid";

describe("daemon PID validation", () => {
  test("accepts the positive decimal PID format written by the daemon", () => {
    expect(parseDaemonPid("12345\n")).toBe(12345);
    expect(parseDaemonPid(String(process.pid))).toBe(process.pid);
  });
  test("rejects process-group targets and malformed or out-of-range files", () => {
    for (const value of [
      "",
      " ",
      "0",
      "-1",
      "-123",
      "1.5",
      "1e3",
      "0x10",
      "NaN",
      "Infinity",
      "2147483648",
    ]) {
      expect(parseDaemonPid(value)).toBeNull();
    }
  });
});
