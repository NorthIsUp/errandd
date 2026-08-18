// Guards the curated-grammar highlighter that replaced the full shiki bundle
// (10.4MB -> 2.8MB of v3 app.js). Two things can silently break:
//   1. a bundled language stops highlighting (grammar import wrong / renamed),
//   2. an UNBUNDLED language throws instead of degrading to plain text —
//      transcripts contain whatever fence the model wrote, so this is the
//      failure users would actually hit.
import { describe, expect, test } from "bun:test";
import { bundledLanguages, highlightToHtml } from "../../web/v3/lib/highlighter";

const THEME = "github-light";

describe("highlightToHtml", () => {
  test.each([
    ["typescript", "const x: number = 1"],
    ["tsx", "const A = () => <div />"],
    ["bash", "echo hi | grep h"], // alias, resolved via the shellscript grammar
    ["json", '{"a":1}'],
    ["yaml", "a: 1"],
    ["python", "def f():\n    return 1"],
    ["diff", "-old\n+new"],
    ["dockerfile", "FROM alpine"],
    ["hcl", 'resource "a" "b" {}'],
  ])("highlights %s", async (lang, code) => {
    const html = await highlightToHtml(code, lang, THEME);
    // A real grammar match produces at least one token span; plaintext does not.
    expect(html).toContain("<span");
    expect(html).toContain("<pre");
  });

  test("an unbundled language degrades to plain text instead of throwing", async () => {
    const html = await highlightToHtml("defmodule A do\nend", "elixir", THEME);
    expect(html).toContain("<pre");
    expect(html).toContain("defmodule");
  });

  test("plaintext is handled without a grammar", async () => {
    const html = await highlightToHtml("just words", "plaintext", THEME);
    expect(html).toContain("just words");
  });

  test("the dark theme both themes are registered for also renders", async () => {
    const html = await highlightToHtml("const x = 1", "typescript", "github-dark-default");
    expect(html).toContain("<span");
  });

  // Self-maintaining: a grammar added to LANGS is covered here automatically.
  test("every bundled grammar and alias highlights without throwing", async () => {
    const langs = await bundledLanguages();
    expect(langs.length).toBeGreaterThan(15);
    const broken: string[] = [];
    for (const lang of langs) {
      try {
        await highlightToHtml("x = 1\n", lang, THEME);
      } catch (err) {
        broken.push(`${lang}: ${(err as Error).message}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("code is escaped, not injected", async () => {
    const html = await highlightToHtml("<script>alert(1)</script>", "plaintext", THEME);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#x3C;script>");
  });
});
