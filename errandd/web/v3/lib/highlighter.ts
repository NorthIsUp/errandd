// Shiki, minus 9MB.
//
// `import { codeToHtml } from "shiki"` pulls the FULL bundle: 634 grammars and
// every theme. That alone was ~9.3MB of the v3 app.js (10.4MB total vs v2's
// 1.1MB) — downloaded by every dashboard visitor to syntax-highlight the
// handful of languages that actually show up in an agent transcript.
//
// So: the core highlighter, two themes (the only two shikiThemeForActive can
// return), and a hand-picked grammar list. The JavaScript regex engine replaces
// the oniguruma WASM blob, which is another ~500KB that buys nothing here.
//
// A language NOT in this list is not an error — it renders unhighlighted via
// the `plaintext` fallback in `highlightToHtml`. Adding one is a one-line
// import plus a LANGS entry; check bundle-size.test.ts still passes after.
import { createHighlighterCore, createJavaScriptRegexEngine } from "shiki/core";
import type { HighlighterCore } from "shiki/core";

import githubDark from "@shikijs/themes/github-dark-default";
import githubLight from "@shikijs/themes/github-light";

import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import hcl from "@shikijs/langs/hcl";
import html from "@shikijs/langs/html";
import ini from "@shikijs/langs/ini";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
// Carries the bash/sh/zsh aliases, so a ```bash fence resolves through it.
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";

const LANGS = [
  css,
  diff,
  dockerfile,
  go,
  hcl,
  html,
  ini,
  javascript,
  json,
  jsonc,
  markdown,
  python,
  rust,
  shellscript,
  sql,
  toml,
  tsx,
  typescript,
  xml,
  yaml,
];

// Shiki resolves these itself without a grammar; treat them as always-loaded so
// we never look them up and wrongly fall back.
const BUILTIN = new Set(["plaintext", "text", "txt", "ansi"]);

let pending: Promise<HighlighterCore> | null = null;

// One highlighter for the page. Building it parses every grammar above, so
// doing it per code block would be visibly slow on a long transcript.
function getHighlighter(): Promise<HighlighterCore> {
  pending ??= createHighlighterCore({
    themes: [githubLight, githubDark],
    langs: LANGS,
    engine: createJavaScriptRegexEngine(),
  });
  return pending;
}

/**
 * Every language id and alias the bundle can highlight. Exported so a test can
 * exercise all of them: the JavaScript regex engine rejects a small number of
 * TextMate patterns that oniguruma accepts, and that surfaces only when a
 * grammar is actually used.
 */
export async function bundledLanguages(): Promise<string[]> {
  return (await getHighlighter()).getLoadedLanguages();
}

/**
 * Highlight `code` to HTML, degrading to unhighlighted `plaintext` when the
 * language isn't bundled — `codeToHtml` would throw instead, and a transcript
 * can contain any fence the model felt like writing.
 */
export async function highlightToHtml(
  code: string,
  lang: string,
  theme: string
): Promise<string> {
  const highlighter = await getHighlighter();
  const known =
    BUILTIN.has(lang) ||
    highlighter.getLoadedLanguages().includes(lang);
  return highlighter.codeToHtml(code, {
    lang: known ? lang : "plaintext",
    theme,
  });
}
