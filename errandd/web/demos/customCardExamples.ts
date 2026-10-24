import type { ChatExamples } from "../../shared/chatExamples";

/** Explicitly synthetic, safe fixture: display only; never runs commands. */
export const CUSTOM_CARD_EXAMPLES: ChatExamples = {
  version: 1,
  sourceOrigin: "https://github.com/NorthIsUp/errandd",
  capturedAt: "2026-10-23T00:00:00Z",
  examples: [
    {
      id: "custom-cards",
      title: "Synthetic custom-card example",
      threadId: "demo:custom-cards",
      sourceUrl: "https://github.com/NorthIsUp/errandd",
      sources: [],
      totalParts: 9,
      parts: [
        {
          id: "request",
          kind: "text",
          role: "user",
          markdown:
            "## Incoming hook · github issue_comment\n\naction: created · author: preview-reviewer\n\nShow the routine summary, shell commands, and JSON output.",
        },
        {
          id: "routine",
          kind: "tool",
          tool: {
            type: "inspect_routine",
            toolCallId: "routine-preview",
            state: "output-available",
            input: { routine: "pr-review", mode: "preview" },
            output: {
              status: "ready",
              checks: 3,
              changedFiles: ["app/runner.ts", "web/demos/App.tsx"],
            },
          },
        },
        {
          id: "bash-success",
          kind: "tool",
          tool: {
            type: "Bash",
            toolCallId: "bash-success",
            state: "output-available",
            input: { command: "git diff --stat", description: "Inspect changed files" },
            output: {
              text: "app/runner.ts | 8 ++++----\n1 file changed, 4 insertions(+), 4 deletions(-)",
            },
          },
        },
        {
          id: "followup-comment",
          kind: "text",
          role: "user",
          markdown:
            "## Incoming hook · github issue_comment\n\naction: created · author: datadog-official\n\nPlease include the PR metadata so I can inspect the labels.",
        },
        {
          id: "bash-json",
          kind: "tool",
          tool: {
            type: "Bash",
            toolCallId: "bash-json",
            state: "output-available",
            input: { command: "gh pr view 4056 --json number,title,author,labels" },
            output: {
              text: '  {"number":4056,"title":"Reorder checkout","author":{"login":"preview-reviewer"},"labels":[{"name":"maintenance"}]}\n',
            },
          },
        },
        {
          id: "fyi-notice",
          kind: "system",
          notInContext: true,
          text: "Human activity detected. The next scheduled review will wait until the author stops pushing.",
        },
        {
          id: "bash-error",
          kind: "tool",
          tool: {
            type: "Bash",
            toolCallId: "bash-error",
            state: "output-error",
            input: { command: "cat missing-file.md", description: "Read a missing file" },
            output: { text: "cat: missing-file.md: No such file or directory" },
            errorText: "Exit code 1: missing-file.md does not exist",
          },
        },
        {
          id: "file-edit",
          kind: "tool",
          tool: {
            type: "Edit",
            toolCallId: "file-edit",
            state: "output-available",
            input: {
              file_path: "review-preview.md",
              old_string: "description: waiting\nmetadata:\n  status: pending",
              new_string: "description: reviewed\nmetadata:\n  status: ready",
            },
            output: { text: "Updated review-preview.md" },
          },
        },
        {
          id: "answer",
          kind: "text",
          role: "assistant",
          markdown:
            "### Same cards, shared renderers\n\nThe **routine card** is one shared React component registered by tool name. The **Bash rows** reuse Errandd’s existing tool rail and input/output/error renderer. Expand the completed command; the failed command opens automatically.\n\nThis is a synthetic display fixture. No commands ran.\n\n### Diff formats\n\nUnlabeled snippet:\n\n```\n-before\n+after\n```\n\nUnified patch:\n\n```patch\n--- a/review.md\n+++ b/review.md\n@@ -4 +4 @@\n-waiting\n+ready\n```\n\nNormal diff:\n\n```text\n1c1\n< waiting\n---\n> ready\n```\n\nContext diff:\n\n```\n*** old.md\n--- new.md\n***************\n*** 1 ****\n! waiting\n--- 1 ----\n! ready\n```",
        },
      ],
    },
  ],
};
