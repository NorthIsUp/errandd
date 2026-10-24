import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { ToolOutput, toolOutputText } from "./ToolOutput";

test("shell JSON uses a viewer and preserves the exact raw clipboard source", () => {
  const raw = '  {"checks": [1, {"passed": true}], "empty": null} \n';
  const output = { text: raw };
  expect(toolOutputText("Bash", output).raw).toBe(raw);
  const html = renderToString(<ToolOutput toolName="Bash" output={output} />);
  expect(html).toContain('data-output-format="json"');
  expect(html).toContain('aria-label="JSON output"');
  expect(html).toContain('aria-label="Copy output"');
  expect(html).toContain("checks");
  expect(html).not.toContain("Result metadata");
});

test("arrays and JSON scalars are valid; partial JSON and logs remain text", () => {
  for (const raw of ["[1,2]", "null", "false", "42", '"hello"']) {
    expect(renderToString(<ToolOutput toolName="Bash" output={{ text: raw }} />)).toContain(
      'data-output-format="json"',
    );
  }
  for (const raw of ['{"unfinished":', 'log\n{"ok":true}', ""]) {
    expect(renderToString(<ToolOutput toolName="Bash" output={{ text: raw }} />)).toContain(
      'data-output-format="text"',
    );
  }
});

test("shell stdout metadata is retained and non-shell output keeps its existing representation", () => {
  const html = renderToString(
    <ToolOutput toolName="Bash" output={{ stdout: '{"ok":true}', stderr: "warning" }} />,
  );
  expect(html).toContain("Result metadata");
  expect(html).toContain("warning");
  expect(toolOutputText("Read", { text: '{"ok":true}' }).raw).toBe(
    JSON.stringify({ text: '{"ok":true}' }, null, 2),
  );
});
