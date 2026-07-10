import { describe, expect, test } from "bun:test"
import rehypeParse from "rehype-parse"
import rehypeSanitize from "rehype-sanitize"
import rehypeStringify from "rehype-stringify"
import { unified } from "unified"
import { sanitizeSchema } from "./markdown"

// The Markdown component runs rehype-raw → rehype-sanitize(sanitizeSchema) over
// embedded HTML in GitHub comment bodies. There's no jsdom in this repo, so we
// exercise the SECURITY-critical half directly: run untrusted HTML through the
// same sanitize schema and assert the allowlist keeps the GitHub-comment patterns
// and drops the dangerous ones. (rehype-raw just parses already-HTML into hast;
// the sanitize schema is the part that decides what survives.)
function sanitize(html: string): string {
  return String(
    unified()
      .use(rehypeParse, { fragment: true })
      .use(rehypeSanitize, sanitizeSchema)
      .use(rehypeStringify)
      .processSync(html),
  )
}

describe("Markdown sanitize schema — GitHub comment HTML", () => {
  test("KEEPS the Greptile collapsible pattern (details/summary/headings)", () => {
    const out = sanitize(
      "<details><summary><h3>Greptile Summary</h3></summary><p>looks good</p></details>",
    )
    expect(out).toContain("<details>")
    expect(out).toContain("<summary>")
    expect(out).toContain("<h3>")
    expect(out).toContain("Greptile Summary")
  })

  test("KEEPS tables, formatting, and GFM task-list checkboxes", () => {
    expect(sanitize("<table><tbody><tr><td>a</td></tr></tbody></table>")).toContain("<table>")
    expect(sanitize("<strong>b</strong><em>i</em><del>d</del>")).toContain("<strong>")
    expect(sanitize('<input type="checkbox" disabled checked>')).toContain("<input")
  })

  test("KEEPS an https img with alt text", () => {
    const out = sanitize('<img src="https://example.com/badge.svg" alt="status">')
    expect(out).toContain("<img")
    expect(out).toContain('src="https://example.com/badge.svg"')
    expect(out).toContain('alt="status"')
  })

  test("DROPS <script> entirely", () => {
    const out = sanitize("<p>hi</p><script>alert(1)</script>")
    expect(out).not.toContain("<script")
    expect(out).not.toContain("alert(1)")
  })

  test("DROPS <style> entirely", () => {
    expect(sanitize("<style>body{display:none}</style>ok")).not.toContain("<style")
  })

  test("STRIPS on* event-handler attributes", () => {
    const out = sanitize('<img src="https://x/y.png" onerror="alert(1)">')
    expect(out).not.toContain("onerror")
    expect(out).not.toContain("alert(1)")
  })

  test("NEUTRALIZES javascript: hrefs (the link survives, the protocol does not)", () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain("javascript:")
  })

  test("DROPS data: URLs on img src (default-deny on inline data images)", () => {
    const out = sanitize('<img src="data:image/png;base64,AAAA">')
    expect(out).not.toContain("data:image")
  })
})
