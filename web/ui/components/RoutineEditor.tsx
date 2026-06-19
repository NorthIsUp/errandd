/**
 * Syntax-highlighted code editor for routine `.md` files.
 *
 * Built on CodeMirror 6 via @uiw/react-codemirror. The routine format is
 * markdown body with a YAML frontmatter block; we run the markdown
 * language extension (which highlights the body) and overlay a custom
 * completion source that knows the routine YAML schema — `schedule`,
 * `on.pr.*`, `on.comments`, `skip_self`, etc.
 *
 * Completions only trigger inside the frontmatter (first `---` to the
 * matching closing `---`) so they don't fire while the user types prose.
 */

import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

interface RoutineEditorProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Schema-driven autocomplete options for routine frontmatter.
 *
 * Each entry has a label (the YAML key) and a `value` template the
 * editor inserts on accept. The template is plain text — no snippet
 * placeholders — because CodeMirror's snippet system needs a separate
 * extension and the marginal UX gain isn't worth the bundle hit.
 */
const FRONTMATTER_KEYS: { label: string; value: string; info: string }[] = [
  { label: "on", value: 'on:\n  - schedule: "0 9 * * *"', info: "Triggers list (schedule / pr / comments / sentry / datadog)" },
  { label: "recurring", value: "recurring: true", info: "true to keep firing on schedule; false for one-shot" },
  { label: "enabled", value: "enabled: true", info: "Set false to pause without deleting" },
  { label: "notify", value: "notify: error", info: "Notify channel: true | false | error" },
  { label: "skip_self", value: "skip_self: false", info: "Set false to allow clawdcode's own events to trigger (default skips self)" },
  { label: "reuse_session", value: "reuse_session: false", info: "Resume the same Claude session each fire" },
  { label: "model", value: "model: sonnet", info: "Override the default model for this routine" },
  { label: "effort", value: "effort: medium", info: "Reasoning effort: low | medium | high" },
];

const ON_KEYS: { label: string; value: string; info: string }[] = [
  { label: "schedule", value: 'schedule: "0 9 * * *"', info: "Cron trigger (repeatable — add multiple `- schedule:` entries)" },
  { label: "pr", value: "pr:\n    repo: org/repo\n    user: [\"*\", \"!*[bot]\"]", info: "Per-rule PR matcher (repo / user / action / branch / labels / draft)" },
  { label: "prs", value: "prs: true", info: "Shorthand: any PR not targeting main" },
  { label: "comments", value: "comments: true", info: "Fire on review/comment events" },
  { label: "sentry", value: "sentry: true", info: "Fire on Sentry webhooks (or a filtered mapping)" },
  { label: "datadog", value: "datadog: true", info: "Fire on Datadog webhooks (or a filtered mapping)" },
];

const PR_RULE_KEYS: { label: string; value: string; info: string }[] = [
  { label: "repo", value: 'repo: "org/repo"', info: "GitHub repo glob — `org/*`, list, etc." },
  { label: "user", value: 'user: ["*", "!*[bot]"]', info: "Include/exclude globs; `!` excludes. Order matters." },
  { label: "action", value: "action: [opened, synchronize, reopened]", info: "PR webhook actions to match" },
  { label: "branch", value: 'branch: ["!main"]', info: "Base branch globs; defaults to `*`" },
  { label: "labels", value: "labels: [ready-for-review]", info: "Match only PRs with these labels" },
  { label: "draft", value: "draft: false", info: "false (skip drafts) | true (drafts only) | \"any\"" },
];

/** Find the frontmatter line range — null when no closing `---` yet. */
function frontmatterRange(text: string): { start: number; end: number } | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const close = text.indexOf("\n---", 3);
  if (close === -1) return { start: 0, end: text.length };
  return { start: 0, end: close + 4 };
}

/** Detect indent of the line at `pos`. Returns 0 for top-level, 2 for
 *  one level in (the `on:` mapping), 4 for the `pr` list items. */
function indentAt(doc: string, pos: number): number {
  // Find the start of the current line.
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  let i = lineStart;
  let indent = 0;
  while (i < pos && doc[i] === " ") {
    indent++;
    i++;
  }
  return indent;
}

/** Check whether the cursor sits inside the value of an `on:` mapping —
 *  i.e. some recent line said `on:` at indent 0 and we haven't dedented
 *  back to 0 since. */
function inOnBlock(doc: string, pos: number): boolean {
  const before = doc.slice(0, pos);
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const m = /^(\s*)\S/.exec(line);
    const indent = m ? (m[1] ?? "").length : 0;
    if (indent === 0) {
      return /^on\s*:/.test(line);
    }
  }
  return false;
}

/** Check whether the cursor is inside a `pr:` list item (under `on:`). */
function inPrRule(doc: string, pos: number): boolean {
  const before = doc.slice(0, pos);
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    if (/^\s*-\s/.test(line) && /pr\s*:/.test(lines[i - 1] ?? "")) return true;
    if (/^\s{4}-\s/.test(line)) return true;
    const m = /^(\s*)\S/.exec(line);
    const indent = m ? (m[1] ?? "").length : 0;
    if (indent === 0) return false;
  }
  return false;
}

function routineCompletions(context: CompletionContext): CompletionResult | null {
  const doc = context.state.doc.toString();
  const pos = context.pos;
  const fm = frontmatterRange(doc);
  if (!fm || pos < fm.start || pos > fm.end) {
    return null;
  }

  // Find the word being typed. Words start with [A-Za-z_].
  const word = context.matchBefore(/[A-Za-z_][\w-]*/);
  if (!word && !context.explicit) return null;
  const from = word ? word.from : pos;

  // Decide which set of completions applies based on indent + context.
  const indent = indentAt(doc, pos);
  let options = FRONTMATTER_KEYS;
  if (indent >= 2 && inOnBlock(doc, pos)) {
    if (inPrRule(doc, pos) && indent >= 4) {
      options = PR_RULE_KEYS;
    } else {
      options = ON_KEYS;
    }
  }

  return {
    from,
    options: options.map((opt) => ({
      label: opt.label,
      apply: opt.value,
      info: opt.info,
      type: "property",
    })),
    validFor: /^[A-Za-z_][\w-]*$/,
  };
}

export function RoutineEditor({ value, onChange }: RoutineEditorProps) {
  // Extensions are memoized so CodeMirror doesn't re-init on every render.
  const extensions = useMemo(
    () => [
      // yamlFrontmatter wraps the markdown extension so the frontmatter
      // block gets YAML highlighting (keys, strings, booleans) while the
      // body stays markdown.
      yamlFrontmatter({ content: markdown() }),
      autocompletion({ override: [routineCompletions] }),
      EditorView.lineWrapping,
    ],
    [],
  );

  return (
    <div className="rounded-box border border-base-300 overflow-hidden">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        // Inherit the daisyUI base background so the editor blends with the
        // surrounding Card instead of looking like a stuck-in iframe.
        theme="none"
        height="min-h-[24rem]"
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          autocompletion: false, // we provide our own via the extension above
          foldGutter: false,
        }}
        className="text-sm"
      />
    </div>
  );
}
