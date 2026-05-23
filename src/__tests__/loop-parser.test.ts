import { test, expect } from "bun:test";
import { parseLoopArgs } from "../loop-parser";

test("5m → */5 * * * *", () => {
  const r = parseLoopArgs("5m write a haiku");
  expect(r.ok).toBe(true);
  expect(r.cron).toBe("*/5 * * * *");
  expect(r.prompt).toBe("write a haiku");
});

test("2h → 0 */2 * * *", () => {
  const r = parseLoopArgs("2h do something");
  expect(r.ok).toBe(true);
  expect(r.cron).toBe("0 */2 * * *");
  expect(r.prompt).toBe("do something");
});

test("1d → 0 0 */1 * *", () => {
  const r = parseLoopArgs("1d daily report");
  expect(r.ok).toBe(true);
  expect(r.cron).toBe("0 0 */1 * *");
  expect(r.prompt).toBe("daily report");
});

test("quoted cron literal", () => {
  const r = parseLoopArgs('"0 9 * * *" report stats');
  expect(r.ok).toBe(true);
  expect(r.cron).toBe("0 9 * * *");
  expect(r.prompt).toBe("report stats");
});

test("bad interval → ok:false", () => {
  const r = parseLoopArgs("5x do something");
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Unrecognised interval/);
});

test("missing prompt → ok:false", () => {
  const r = parseLoopArgs("5m");
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/No prompt/);
});

test("empty input → ok:false", () => {
  const r = parseLoopArgs("");
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Usage/);
});

test("quoted cron wrong field count → ok:false", () => {
  const r = parseLoopArgs('"0 9 * *" report');
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/5 fields/);
});

test("unclosed quote → ok:false", () => {
  const r = parseLoopArgs('"0 9 * * * report');
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Unclosed quote/);
});

test("30m interval", () => {
  const r = parseLoopArgs("30m check metrics");
  expect(r.ok).toBe(true);
  expect(r.cron).toBe("*/30 * * * *");
  expect(r.prompt).toBe("check metrics");
});

test("1h interval", () => {
  const r = parseLoopArgs("1h ping health");
  expect(r.ok).toBe(true);
  expect(r.cron).toBe("0 */1 * * *");
  expect(r.prompt).toBe("ping health");
});
