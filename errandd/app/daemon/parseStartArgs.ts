/**
 * Pure argument parser for `errandd start` (codebase-audit P1).
 *
 * Lifted verbatim out of the start() closure so it can be unit-tested without
 * spawning a daemon. Behaviour-identical to the former inline loop: same flags,
 * same validation order, same exact stderr messages. The only structural change
 * is that validation failures are RETURNED (`{ ok: false, error }`) instead of
 * calling `process.exit(1)` inline — start() prints `error` and exits, so the
 * observable CLI behaviour (message text + exit code 1) is unchanged.
 */

export interface ParsedStartArgs {
  hasPromptFlag: boolean;
  hasTriggerFlag: boolean;
  telegramFlag: boolean;
  discordFlag: boolean;
  slackFlag: boolean;
  debugFlag: boolean;
  webFlag: boolean;
  replaceExistingFlag: boolean;
  webPortFlag: number | null;
  webHostFlag: string | null;
  webTrustTailnetFlag: boolean;
  payload: string;
}

export type ParseStartArgsResult =
  | { ok: true; value: ParsedStartArgs }
  | { ok: false; error: string };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat flag-dispatch loop + sequential validation; lifted verbatim out of start() to be testable. Splitting the flag cases would obscure the 1:1 mapping to the CLI surface.
export function parseStartArgs(args: string[]): ParseStartArgsResult {
  let hasPromptFlag = false;
  let hasTriggerFlag = false;
  let telegramFlag = false;
  let discordFlag = false;
  let slackFlag = false;
  let debugFlag = false;
  let webFlag = false;
  let replaceExistingFlag = false;
  let webPortFlag: number | null = null;
  let webHostFlag: string | null = null;
  let webTrustTailnetFlag = false;
  const payloadParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prompt") {
      hasPromptFlag = true;
    } else if (arg === "--trigger") {
      hasTriggerFlag = true;
    } else if (arg === "--telegram") {
      telegramFlag = true;
    } else if (arg === "--discord") {
      discordFlag = true;
    } else if (arg === "--slack") {
      slackFlag = true;
    } else if (arg === "--debug") {
      debugFlag = true;
    } else if (arg === "--web") {
      webFlag = true;
    } else if (arg === "--replace-existing") {
      replaceExistingFlag = true;
    } else if (arg === "--web-port") {
      const raw = args[i + 1];
      if (!raw) {
        return { ok: false, error: "`--web-port` requires a numeric value." };
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        return { ok: false, error: "`--web-port` must be a valid TCP port (1-65535)." };
      }
      webPortFlag = parsed;
      i++;
    } else if (arg === "--web-host") {
      const raw = args[i + 1];
      if (!raw) {
        return {
          ok: false,
          error: "`--web-host` requires a value (e.g. 127.0.0.1, 0.0.0.0).",
        };
      }
      webHostFlag = raw;
      i++;
    } else if (arg === "--web-trust-tailnet") {
      // Treat requests carrying a non-empty Tailscale-User-Login header as
      // authenticated. Safe only when the daemon is fronted by the Tailscale
      // operator's Ingress proxy and that proxy is the only upstream that
      // can reach the port (e.g. enforced by NetworkPolicy). Funnel-origin
      // requests do not carry this header.
      webTrustTailnetFlag = true;
    } else {
      payloadParts.push(arg);
    }
  }
  const payload = payloadParts.join(" ").trim();
  if (hasPromptFlag && !payload) {
    return {
      ok: false,
      error:
        "Usage: errandd start --prompt <prompt> [--trigger] [--telegram] [--discord] [--slack] [--debug] [--web] [--web-port <port>] [--replace-existing]",
    };
  }
  if (!hasPromptFlag && payload) {
    return { ok: false, error: "Prompt text requires `--prompt`." };
  }
  if (telegramFlag && !hasTriggerFlag) {
    return { ok: false, error: "`--telegram` with `start` requires `--trigger`." };
  }
  if (discordFlag && !hasTriggerFlag) {
    return { ok: false, error: "`--discord` with `start` requires `--trigger`." };
  }
  if (slackFlag && !hasTriggerFlag) {
    return { ok: false, error: "`--slack` with `start` requires `--trigger`." };
  }
  if (hasPromptFlag && !hasTriggerFlag && (webFlag || webPortFlag !== null)) {
    return {
      ok: false,
      error: "`--web` is daemon-only. Remove `--prompt`, or add `--trigger`.",
    };
  }

  return {
    ok: true,
    value: {
      hasPromptFlag,
      hasTriggerFlag,
      telegramFlag,
      discordFlag,
      slackFlag,
      debugFlag,
      webFlag,
      replaceExistingFlag,
      webPortFlag,
      webHostFlag,
      webTrustTailnetFlag,
      payload,
    },
  };
}
