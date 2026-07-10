import { describe, expect, test } from "bun:test";
import { parseStartArgs } from "./parseStartArgs";

function ok(args: string[]) {
  const r = parseStartArgs(args);
  if (!r.ok) {
    throw new Error(`expected ok, got error: ${r.error}`);
  }
  return r.value;
}

function err(args: string[]) {
  const r = parseStartArgs(args);
  if (r.ok) {
    throw new Error("expected error, got ok");
  }
  return r.error;
}

describe("parseStartArgs", () => {
  test("no args → all flags false, empty payload", () => {
    const v = ok([]);
    expect(v).toEqual({
      hasPromptFlag: false,
      hasTriggerFlag: false,
      telegramFlag: false,
      discordFlag: false,
      slackFlag: false,
      debugFlag: false,
      webFlag: false,
      replaceExistingFlag: false,
      webPortFlag: null,
      webHostFlag: null,
      webTrustTailnetFlag: false,
      payload: "",
    });
  });

  test("boolean flags set", () => {
    const v = ok([
      "--trigger",
      "--telegram",
      "--discord",
      "--slack",
      "--debug",
      "--web",
      "--replace-existing",
      "--web-trust-tailnet",
    ]);
    expect(v.hasTriggerFlag).toBe(true);
    expect(v.telegramFlag).toBe(true);
    expect(v.discordFlag).toBe(true);
    expect(v.slackFlag).toBe(true);
    expect(v.debugFlag).toBe(true);
    expect(v.webFlag).toBe(true);
    expect(v.replaceExistingFlag).toBe(true);
    expect(v.webTrustTailnetFlag).toBe(true);
  });

  test("prompt with payload (multi-word joined + trimmed)", () => {
    const v = ok(["--prompt", "hello", "world"]);
    expect(v.hasPromptFlag).toBe(true);
    expect(v.payload).toBe("hello world");
  });

  test("--web-port consumes next arg and validates range", () => {
    expect(ok(["--web-port", "8080"]).webPortFlag).toBe(8080);
    expect(err(["--web-port"])).toBe("`--web-port` requires a numeric value.");
    expect(err(["--web-port", "0"])).toBe("`--web-port` must be a valid TCP port (1-65535).");
    expect(err(["--web-port", "70000"])).toBe("`--web-port` must be a valid TCP port (1-65535).");
    expect(err(["--web-port", "abc"])).toBe("`--web-port` must be a valid TCP port (1-65535).");
  });

  test("--web-host consumes next arg", () => {
    expect(ok(["--web-host", "0.0.0.0"]).webHostFlag).toBe("0.0.0.0");
    expect(err(["--web-host"])).toBe("`--web-host` requires a value (e.g. 127.0.0.1, 0.0.0.0).");
  });

  test("--prompt without payload → usage error", () => {
    expect(err(["--prompt"])).toContain("Usage: errandd start --prompt");
  });

  test("payload without --prompt → error", () => {
    expect(err(["hello"])).toBe("Prompt text requires `--prompt`.");
  });

  test("channel flags require --trigger", () => {
    expect(err(["--telegram"])).toBe("`--telegram` with `start` requires `--trigger`.");
    expect(err(["--discord"])).toBe("`--discord` with `start` requires `--trigger`.");
    expect(err(["--slack"])).toBe("`--slack` with `start` requires `--trigger`.");
  });

  test("--web with --prompt and no --trigger → daemon-only error", () => {
    expect(err(["--prompt", "hi", "--web"])).toBe(
      "`--web` is daemon-only. Remove `--prompt`, or add `--trigger`.",
    );
    expect(err(["--prompt", "hi", "--web-port", "9000"])).toBe(
      "`--web` is daemon-only. Remove `--prompt`, or add `--trigger`.",
    );
  });

  test("--web with --prompt and --trigger is allowed", () => {
    const v = ok(["--prompt", "hi", "--trigger", "--web"]);
    expect(v.webFlag).toBe(true);
    expect(v.payload).toBe("hi");
  });

  test("unknown args become payload (when --prompt present)", () => {
    expect(ok(["--prompt", "a", "--unknown", "b"]).payload).toBe("a --unknown b");
  });
});
