import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTranscriptUsage,
  calcSessionCost,
} from "../ui/services/usage";

// One assistant turn's worth of identical token usage, replayed under different
// models. If cost is model-aware, the same tokens must price differently.
const USAGE = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "errandd-usage-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

function assistant(model: string | undefined, id: string) {
  const message: Record<string, unknown> = { id, usage: USAGE };
  if (model !== undefined) message.model = model;
  return { type: "assistant", message };
}

async function costFor(lines: object[]) {
  const path = transcript(lines);
  try {
    return calcSessionCost(await parseTranscriptUsage(path));
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
}

describe("per-model cost attribution (Sonnet-for-all bug is gone)", () => {
  test("an Opus session prices differently than a Sonnet session with identical tokens", async () => {
    const opus = await costFor([assistant("claude-opus-4-8", "m1")]);
    const sonnet = await costFor([assistant("claude-sonnet-4-6", "m1")]);

    // The core regression: Opus is no longer priced at the Sonnet rate.
    expect(opus.costUsd).not.toBeCloseTo(sonnet.costUsd, 6);
    // Opus list pricing (5/25 per MTok) exceeds Sonnet (3/15) for the same tokens.
    expect(opus.costUsd).toBeGreaterThan(sonnet.costUsd);
    // 1M input @ $5 + 1M output @ $25 = $30 exactly.
    expect(opus.costUsd).toBeCloseTo(30, 6);
    expect(sonnet.costUsd).toBeCloseTo(18, 6);
    // Real per-model attribution → not an estimate.
    expect(opus.isEstimate).toBe(false);
    expect(sonnet.isEstimate).toBe(false);
  });

  test("Haiku also prices differently than Sonnet", async () => {
    const haiku = await costFor([assistant("claude-haiku-4-5", "m1")]);
    const sonnet = await costFor([assistant("claude-sonnet-4-6", "m1")]);
    expect(haiku.costUsd).toBeLessThan(sonnet.costUsd);
    expect(haiku.costUsd).toBeCloseTo(6, 6); // 1M @ $1 + 1M @ $5
  });

  test("a mixed-model session sums per-message by that message's model", async () => {
    const mixed = await costFor([
      assistant("claude-opus-4-8", "m1"),
      assistant("claude-sonnet-4-6", "m2"),
    ]);
    // Opus turn ($30) + Sonnet turn ($18) = $48 — not 2× either flat rate.
    expect(mixed.costUsd).toBeCloseTo(48, 6);
    expect(mixed.isEstimate).toBe(false);
  });

  test("a transcript with no model field is flagged as an estimate (Sonnet rate)", async () => {
    const estimate = await costFor([assistant(undefined, "m1")]);
    expect(estimate.isEstimate).toBe(true);
    // Estimate falls back to Sonnet rates rather than silently applying them as truth.
    expect(estimate.costUsd).toBeCloseTo(18, 6);
  });

  test("synthetic-only messages count as modelless (estimate)", async () => {
    const synthetic = await costFor([assistant("<synthetic>", "m1")]);
    expect(synthetic.isEstimate).toBe(true);
  });
});
