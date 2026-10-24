import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const cssPath = join(import.meta.dir, "../../dist/web/demos/app.css");

// Run after build:web: this catches auxiliary code-split CSS overwriting the
// main stylesheet, which successful HTML/SSR rendering cannot detect.
test.skipIf(!existsSync(cssPath))(
  "demo entry stylesheet contains assistant-ui and host styles",
  () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".demo-gallery");
    expect(css).toContain(".comparison-panels");
    expect(css).toContain(".aui-demo-thread");
    expect(css).toContain(".aui-demo-composer");
    expect(css).toContain(".demo-activity");
  },
);

const originalCssPath = join(import.meta.dir, "../../dist/web/demos-original/app.css");
test.skipIf(!existsSync(originalCssPath))(
  "original comparison keeps its theme isolated and styled",
  () => {
    const css = readFileSync(originalCssPath, "utf8");
    expect(css).toContain(".original-transcript");
    expect(css).toContain("--color-base-100");
  },
);

test.skipIf(!existsSync(cssPath))("demos contain no hosted setup or CopilotKit UI", () => {
  const js = readFileSync(join(import.meta.dir, "../../dist/web/demos/app.js"), "utf8");
  expect(js).not.toContain("/api/assistant-cloud/");
  expect(js).not.toContain("Connect Assistant Cloud");
  expect(js).not.toContain("function CopilotChatView");
});
