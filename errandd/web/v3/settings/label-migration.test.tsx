import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EventSourcesPanel } from "./EventSourcesPanel";
import { defaultCveConnection } from "../../../shared/eventSources";

test.each([false, true])("GitHub settings render the migration toggle with its persisted enabled state: %s", async enabled => {
  const html = renderToStaticMarkup(<EventSourcesPanel
    sources={[{ id: "github", url: "/api/webhooks/github", configured: true, secretEnv: "ERRANDD_GITHUB_WEBHOOK_SECRET", modes: ["webhook"], errands: [] }]}
    selected="github" connection={defaultCveConnection()} onChange={() => {}} navigate={() => {}} openErrands={() => {}}
    legacyLabels={{ enabled, onChange: () => {} }} />);
  const controls: boolean[] = [];
  await new HTMLRewriter().on('input[aria-label="Look for claw:* labels and rename them to errandd:*"]', {
    element(element) { controls.push(element.hasAttribute("checked")); },
  }).transform(new Response(html)).text();
  expect(controls).toEqual([enabled]);
  expect(html).toContain("No LLM interaction");
  expect(html).toContain("Label compatibility");
});
