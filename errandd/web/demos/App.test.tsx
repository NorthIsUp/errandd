import { afterAll, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { App } from "./App";

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: { getItem: () => null },
});
afterAll(() => {
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
  if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});
function render(path: string) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL(path, "http://localhost"),
  });
  return renderToString(<App />);
}

test("gallery links to the selected assistant-ui demos", () => {
  const html = render("/demos/chat");
  expect(html).toContain("/demos/chat/compare");
  expect(html).toContain("/demos/chat/assistant-ui");
  expect(html).toContain("/demos/chat/cards");
  expect(html).toContain("Scripted preview");
});
test("assistant-ui route offers captured chats and a native interactive runtime", () => {
  const captures = render("/demos/chat/compare");
  expect(captures).toContain("Try interactive chat");
  expect(captures).toContain("Loading captured conversations");
  const interactive = render("/demos/chat/assistant-ui?mode=scripted");
  expect(interactive).toContain("native AG-UI runtime");
  expect(interactive).toContain("aui-demo-composer");
  expect(interactive).toContain("textarea");
  expect(interactive).not.toContain("data-copilotkit");
});
test("assistant-ui is interactive by default and cards are immediately visible", () => {
  const interactive = render("/demos/chat/assistant-ui");
  expect(interactive).toContain("textarea");
  const cards = render("/demos/chat/cards");
  expect(cards).toContain('data-custom-card="routine"');
  expect(cards).toContain("Synthetic custom-card example");
});
test("live mode remains explicit and links back to the scripted preview", () => {
  const html = render("/demos/chat/assistant-ui?mode=live");
  expect(html).toContain("Live agent");
  expect(html).toContain("Use scripted preview");
});
