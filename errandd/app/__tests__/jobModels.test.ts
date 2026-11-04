import { describe, expect, test } from "bun:test";
import { JobModelSelector, resolveJobModel, jobModelThreadId } from "../jobModels";
import { createRuntime } from "../runtime/registry";
import { getRuntime, withRuntime } from "../runtime/select";

describe("errand model selection", () => {
  test("sessions remain stable per choice and separate across runtimes and models", () => {
    const thread = "review:hook:org/repo#42";
    const claude = { runtime: "claude", model: "sonnet" };
    const codex = { runtime: "codex", model: "gpt-example-sol" };
    expect(jobModelThreadId(thread)).toBe(thread);
    expect(jobModelThreadId(thread, claude)).toBe(jobModelThreadId(thread, { ...claude }));
    expect(jobModelThreadId(thread, claude)).not.toBe(jobModelThreadId(thread, codex));
    expect(jobModelThreadId(thread, claude)).not.toBe(jobModelThreadId(thread, { ...claude, model: "opus" }));
    expect(jobModelThreadId("other", claude)).not.toBe(jobModelThreadId(thread, claude));
  });
  test("round robin survives reloads, isolates errands and resets changed lists", () => {
    const selector = new JobModelSelector();
    const job = { name: "review", models: ["sonnet", "sol"] };
    expect(selector.select(job)).toBe("sonnet");
    expect(selector.select({ ...job })).toBe("sol");
    expect(selector.select({ ...job, sourceDir: "/other" })).toBe("sonnet");
    expect(selector.select(job)).toBe("sonnet");
    expect(selector.select({ ...job, models: ["sol", "haiku"] })).toBe("sol");
    expect(selector.select({ name: "legacy" })).toBeUndefined();
  });

  test("random selects from the whole list without advancing round robin", () => {
    const selector = new JobModelSelector();
    const job = { name: "review", models: ["sonnet", "sol"], modelSelection: "random" as const };
    expect(selector.select(job, () => 0)).toBe("sonnet");
    expect(selector.select(job, () => 0.999)).toBe("sol");
    expect(selector.select({ ...job, modelSelection: "rr" })).toBe("sonnet");
  });

  test("infers providers, honors qualifiers and resolves family aliases from catalog order", () => {
    expect(resolveJobModel("sonnet", "codex")).toEqual({ runtime: "claude", model: "sonnet" });
    expect(resolveJobModel("anthropic/sonnet", "pi")).toEqual({ runtime: "claude", model: "sonnet" });
    expect(resolveJobModel("openai/sol", "claude", ["gpt-new-sol", "gpt-old-sol"])).toEqual({ runtime: "codex", model: "gpt-new-sol" });
    expect(resolveJobModel("gpt-pinned-sol", "claude")).toEqual({ runtime: "codex", model: "gpt-pinned-sol" });
    expect(resolveJobModel("pi/custom", "claude")).toEqual({ runtime: "pi", model: "custom" });
    expect(resolveJobModel("custom", "pi")).toEqual({ runtime: "pi", model: "custom" });
    expect(() => resolveJobModel("sol", "claude", [])).toThrow("specify a full model ID");
    expect(() => createRuntime("typo")).toThrow("Unknown errand runtime");
  });

  test("concurrent runtime scopes survive awaits without changing the daemon default", async () => {
    const defaultRuntime = getRuntime();
    const results = await Promise.all(["claude", "codex"].map((id) =>
      withRuntime(createRuntime(id), async () => {
        await Bun.sleep(5);
        expect(getRuntime().id).toBe(id);
        return getRuntime().buildRunArgs({
          prompt: "test", model: "chosen", outputMode: "stream", jobsRepoArgs: [],
          security: { level: "moderate", allowedTools: [], disallowedTools: [] },
        });
      }),
    ));
    expect(results[0]).toContain("chosen");
    expect(results[1]).toContain("exec");
    expect(results[1]).toContain("chosen");
    expect(getRuntime()).toBe(defaultRuntime);
  });
});
