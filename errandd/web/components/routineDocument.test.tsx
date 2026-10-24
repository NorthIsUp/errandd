import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { routineDocument } from "../../shared/routineDocument";
import { RoutineDocument } from "./RoutineDocument";
import { TextPart } from "../v3/components/parts/TextPart";

const userRole = "user";
const assistantRole = "assistant";

test("job instructions become a document while the incoming hook keeps its attribution", () => {
  const context = "## Incoming hook · github issue_comment\nrepo#42 · author: maya\nPlease review.\n\n";
  const body = "# PR comment responder\r\n\r\n## Review\r\n- Read the conversation.\r\n- Run the checks.\r\n";
  expect(routineDocument(context + body)).toEqual({ context: context.trimEnd(), body, content: "## Review\r\n- Read the conversation.\r\n- Run the checks.\r\n", title: "PR comment responder" });
  const html = renderToString(<TextPart id="0:t" role={userRole} markdown={context + body} />);
  expect(html).toContain('aria-label="Errand job instructions"');
  expect(html).toContain('aria-label="Errandd"');
  expect(html).toContain("github.com/maya.png");
  expect(html).toContain('aria-label="Copy job instructions"');
  expect(html).not.toContain("Run the checks."); // Body mounts when opened.
});

test("routine projection ignores ordinary messages, resumed hooks and headings inside code", () => {
  expect(routineDocument("# A note\nThis is a user message.")).toBeNull();
  expect(routineDocument("## Incoming hook · github issue_comment\nHandle with the context you already have.")).toBeNull();
  const code = "## Incoming hook · github issue_comment\n\n```md\n# Quoted comment\n```\n\n";
  expect(routineDocument(code)).toBeNull();
  expect(routineDocument(code + "# Actual job\nDo the work.")?.title).toBe("Actual job");
  const carryover = '<errandd-session-carryover generation="1">\n# Previous state\n</errandd-session-carryover>\n';
  expect(routineDocument(carryover + code + "# Actual job\nDo the work.")?.context).toContain("Previous state");
  expect(routineDocument(carryover + code + "# Actual job\nDo the work.")?.title).toBe("Actual job");
  expect(routineDocument("Triggered by github\n\n# Legacy job\nInstructions")?.title).toBe("Legacy job");
  const assistant = renderToString(<TextPart id="1:0" role={assistantRole} markdown={code + "# Actual job\nDo the work."} />);
  expect(assistant).not.toContain('aria-label="Errand job instructions"');
});

test("collapsed instruction documents defer rendering expensive Markdown", () => {
  function Body(): never { throw new Error("Should not mount while collapsed"); }
  expect(() => renderToString(<RoutineDocument title="A job" markdown="# A job"><Body /></RoutineDocument>)).not.toThrow();
});
