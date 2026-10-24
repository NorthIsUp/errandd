import { expect, test } from "bun:test";
import { webhookDisplayMarkdown } from "./webhookDisplay";
import { toStockMessages, type CapturedChat } from "./chatExamples";
import { toAnnotatedMessages } from "./chatAnnotations";

const blob = `${"XVE3Yxf6uvYnQRdiwNLuCHfH/0IWV7f4UQZXE"}=:` + "eyJwcmV2aWV3IjoiZGVwbG95bWVudCJ9".repeat(12);
const header = "## Incoming hook · github issue_comment\n[org/repo#42](https://github.com/org/repo/issues/42#issuecomment-1)\n· action: edited · author: vercel[bot]\n";

test("incoming Vercel metadata disappears while action, author and actual body remain", () => {
  const body = `${header}[vc]: #${blob}\nDeployment succeeded. [Review](https://vercel.com/review#details)`;
  expect(webhookDisplayMarkdown(body)).toBe(`${header}Deployment succeeded. [Review](https://vercel.com/review#details)`);
  expect(body).toContain(blob);
  expect(webhookDisplayMarkdown(`${header}[vc]:\n#${blob}\nUseful body`)).toBe(`${header}Useful body`);
  expect(webhookDisplayMarkdown(`${header}[vc]: #${blob}`)).toBe(header.trimEnd());
});

test("coalesced metadata-only edits retain the event, action and actor", () => {
  const body = `## Incoming hooks (2) · pr-42\n1. issue_comment · created by alice — "Please review"\n2. issue_comment · edited by vercel[bot] — "[vc]: #${blob}…⟨+4000⟩"\n\nHandle with the context you already have.`;
  const display = webhookDisplayMarkdown(body);
  expect(display).not.toContain(blob);
  expect(display).toContain("2. issue_comment · edited by vercel[bot]\n");
  expect(display).toContain('1. issue_comment · created by alice — "Please review"');
});

test("anchors, issue references, ordinary reference links and code examples are preserved", () => {
  const body = `${header}See #42 and [details](https://example.com/#${blob}).\n#readable-anchor\n#${blob}\n[vc]: #short-anchor\n[docs]: #${blob}\nExample: \`[vc]: #${blob}\`\n\n\`\`\`md\n[vc]: #${blob}\n\`\`\`\n    [vc]: #${blob}`;
  expect(webhookDisplayMarkdown(body)).toBe(body);
  expect(webhookDisplayMarkdown(`[vc]: #${blob}`)).toBe(`[vc]: #${blob}`);
});

test("demo mapping cleans only incoming user display messages and leaves captured data intact", () => {
  const markdown = `${header}[vc]: #${blob}\nUseful body`;
  const example: CapturedChat = { id: "one", title: "Webhook", threadId: "pr-comments:hook:pr-42", sourceUrl: "https://example.com", totalParts: 3, sources: [], parts: [
    { id: "user", kind: "text", role: "user", markdown },
    { id: "assistant", kind: "text", role: "assistant", markdown },
    { id: "fyi", kind: "system", text: markdown, notInContext: true },
  ] };
  const messages = toStockMessages([example]);
  expect(messages[0]?.content).not.toContain(blob);
  expect(messages[1]?.content).toContain(blob);
  const notice = toAnnotatedMessages([example]).find((message) => message.id === "one:fyi");
  expect(JSON.stringify(notice)).not.toContain(blob);
  expect(JSON.stringify(notice)).toContain("action: edited");
  expect(example.parts[0]?.kind === "text" && example.parts[0].markdown).toBe(markdown);
});
