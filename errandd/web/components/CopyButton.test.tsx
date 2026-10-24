import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { ErranddToolCard } from "../chat/toolCards";
import { CopyButton } from "./CopyButton";

test("copy control is an accessible icon with no visible Copy label", () => {
  const html = renderToString(<CopyButton text="echo hello" label="command" />);
  expect(html).toContain('aria-label="Copy command"');
  expect(html).toContain("<svg");
  expect(html).not.toContain(">Copy<");
});
test("native tool input, output and error each contain their own copy icon", () => {
  const html = renderToString(
    <ErranddToolCard
      tool={{
        type: "Bash",
        state: "output-error",
        input: { command: "false" },
        output: { text: "Command failed" },
        errorText: "Exit code 1",
      }}
    />,
  );
  expect(html).toContain('aria-label="Copy input"');
  expect(html).toContain('aria-label="Copy output"');
  expect(html).toContain('aria-label="Copy error"');
});
