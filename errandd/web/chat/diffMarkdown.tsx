import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import type { Components } from "react-markdown";
import type { ReactNode } from "react";
import { DiffCodeBlock } from "../components/UnifiedDiff";

export function DiffHighlighter({
  code,
  language,
  components: { Pre, Code },
}: SyntaxHighlighterProps) {
  return (
    <DiffCodeBlock code={code} language={language}>
      <Pre>
        <Code>{code}</Code>
      </Pre>
    </DiffCodeBlock>
  );
}
function codeText(value: ReactNode): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map(codeText).join("") : "";
}
/** react-markdown's pre slot supplies block context, so inline code is never
 * mistaken for a diff and the rendered section never sits inside a <pre>. */
export const diffMarkdownComponents: Components = {
  pre: ({ node, children }) => {
    const child = node?.children.find(
      (element) => element.type === "element" && element.tagName === "code",
    );
    if (child?.type !== "element") return <pre>{children}</pre>;
    const text = child.children.map((part) => (part.type === "text" ? part.value : "")).join("");
    const classes = child.properties.className;
    const language = Array.isArray(classes)
      ? classes
          .find((name) => typeof name === "string" && name.startsWith("language-"))
          ?.toString()
          .slice(9)
      : undefined;
    return (
      <DiffCodeBlock code={text || codeText(children)} language={language}>
        <pre>{children}</pre>
      </DiffCodeBlock>
    );
  },
};
