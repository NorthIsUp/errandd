import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { diffMarkdownComponents } from "../chat/diffMarkdown";
import { DiffCodeBlock } from "./UnifiedDiff";

test("unified viewer renders additions/removals and hides synthetic line gutters", () => {
  const html = renderToString(<DiffCodeBlock code={"-old <script>\n+new <script>\n"} />);
  expect(html).toContain('aria-label="Unified diff"');
  expect(html).toContain("diff-code-insert");
  expect(html).toContain("diff-code-delete");
  expect(html).not.toContain('class="diff-gutter');
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain('aria-label="Copy diff"');
});
test("activity markdown detects unlabeled diffs without changing ordinary blocks or inline code", () => {
  const html = renderToString(
    <ReactMarkdown components={diffMarkdownComponents}>
      {"```\n-old\n+new\n```\n\n`-old +new`\n\n```js\nconst n = 1 + 2;\n```"}
    </ReactMarkdown>,
  );
  expect(html.match(/aria-label="Unified diff"/g)).toHaveLength(1);
  expect(html).toContain("<code>-old +new</code>");
  expect(html).toContain("const n = 1 + 2;");
});
