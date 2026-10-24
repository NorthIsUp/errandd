import { expect, test } from "bun:test";
import type { ChatPart } from "../../../shared/transcriptParts";
import { projectThreadContext } from "./threadContext";

test("Context moves instructions and deduplicated sources without mutating provider messages", () => {
  const hook = "## Incoming hook · github issue_comment\nauthor: maya\nPlease review.\n\n";
  const body = "# Review the PR\r\n\r\nInspect the diff.\r\n";
  const parts: ChatPart[] = [
    { id: "0", kind: "text", role: "user", markdown: hook + body },
    { id: "1", kind: "sources", sources: [{ href: "https://github.com/org/repo/pull/42", label: "#42" }] },
    { id: "2", kind: "text", role: "assistant", markdown: "Done." },
    { id: "3", kind: "system", text: hook + body, at: 123 },
    { id: "4", kind: "sources", sources: [{ href: "https://github.com/org/repo/pull/42", label: "#42" }] },
  ];
  const before = JSON.stringify(parts);
  const projected = projectThreadContext(parts);
  expect(JSON.stringify(parts)).toBe(before);
  expect(projected.documents).toHaveLength(1);
  expect(projected.documents[0]).toMatchObject({ body, content: "Inspect the diff.\r\n", at: 123 });
  expect(projected.sources).toHaveLength(1);
  expect(projected.conversation).toEqual([{ id: "0", kind: "text", role: "user", markdown: hook.trimEnd() }, parts[2]!, { id: "3", kind: "system", text: hook.trimEnd(), at: 123 }]);
});

test("FYI, ordinary Markdown and differing historical job versions remain distinguishable", () => {
  const hook = "Triggered by github\n\n";
  const parts: ChatPart[] = [
    { id: "0", kind: "system", text: hook + "# Job\nVersion one" },
    { id: "1", kind: "system", text: hook + "# Job\nVersion two" },
    { id: "2", kind: "text", role: "user", markdown: "# A personal note\nHello" },
    { id: "3", kind: "system", text: hook + "# Bot payload\nNot instructions", notInContext: true },
    { id: "4", kind: "text", role: "assistant", markdown: hook + "# Assistant example\nNot a job" },
  ];
  const projected = projectThreadContext(parts);
  expect(projected.documents.map(document => document.content)).toEqual(["Version two", "Version one"]);
  expect(projected.conversation.slice(2)).toEqual(parts.slice(2));
});
