import type React from "react";

/**
 * Lightweight markdown renderer. Block-level: headings, hr, fenced code,
 * lists, blockquotes, paragraphs. Inline: code, bold, italic, link. No HTML
 * injection — every output node is constructed from parsed tokens.
 */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "hr" }
  | { kind: "fence"; lang: string; lines: string[] }
  | { kind: "frontmatter"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "para"; lines: string[] };

function parse(source: string): Block[] {
  const lines = source.split("\n");
  const out: Block[] = [];
  let i = 0;

  // Leading `---` frontmatter — emit as a dedicated block so the renderer
  // can wrap it in a collapsible "config" disclosure instead of inlining
  // the yaml in the body.
  if (lines[0] === "---") {
    const buf: string[] = [];
    let j = 1;
    while (j < lines.length && lines[j] !== "---") {
      buf.push(lines[j] ?? "");
      j++;
    }
    if (j < lines.length) {
      out.push({ kind: "frontmatter", lines: buf });
      i = j + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fenceOpen = /^```(\S*)\s*$/.exec(line);
    if (fenceOpen) {
      const lang = fenceOpen[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // consume closing fence
      out.push({ kind: "fence", lang, lines: buf });
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const hashes = h[1] ?? "";
      const text = h[2] ?? "";
      const level = hashes.length as 1 | 2 | 3 | 4 | 5 | 6;
      out.push({ kind: "heading", level, text });
      i++;
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const marker = listMatch[2] ?? "";
      const first = listMatch[3] ?? "";
      const ordered = /\d+\./.test(marker);
      const items: string[] = [first];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        // Allow a single blank line between items — common markdown style
        // (`1. foo\n\n2. bar`). Peek ahead; if the next non-blank line is
        // another list marker of the same kind, treat the list as continuing.
        if (/^\s*$/.test(next)) {
          let k = i + 1;
          while (k < lines.length && /^\s*$/.test(lines[k] ?? "")) {
            k++;
          }
          const peek = lines[k] ?? "";
          const pm = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(peek);
          if (!pm) {
            break;
          }
          const peekMarker = pm[2] ?? "";
          const peekOrdered = /\d+\./.test(peekMarker);
          if (peekOrdered !== ordered) {
            break;
          }
          i = k;
          continue;
        }
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(next);
        if (!m) {
          break;
        }
        const nextMarker = m[2] ?? "";
        const isOrdered = /\d+\./.test(nextMarker);
        if (isOrdered !== ordered) {
          break;
        }
        items.push(m[3] ?? "");
        i++;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      out.push({ kind: "quote", lines: buf });
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        /^\s*$/.test(next) ||
        next.startsWith("```") ||
        /^#{1,6}\s/.test(next) ||
        /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(next) ||
        /^(\s*)([-*+]|\d+\.)\s+/.test(next) ||
        /^>\s?/.test(next)
      ) {
        break;
      }
      para.push(next);
      i++;
    }
    out.push({ kind: "para", lines: para });
  }
  return out;
}

export function MarkdownView({ source }: { source: string }) {
  const blocks = parse(source);
  return (
    <div className="md-pretty text-base leading-relaxed space-y-3">
      {blocks.map((b, idx) => renderBlock(b, idx))}
    </div>
  );
}

function renderBlock(b: Block, idx: number): React.ReactNode {
  if (b.kind === "heading") {
    return renderHeading(b.level, b.text, idx);
  }
  if (b.kind === "hr") {
    return <hr key={idx} className="md-hr border-0 border-t border-base-300 my-4" />;
  }
  if (b.kind === "fence") {
    return (
      <pre
        key={idx}
        className="md-fence bg-base-200 border border-base-300 rounded-box px-3 py-2 overflow-x-auto text-sm font-mono"
      >
        {b.lang && <div className="text-xs opacity-60 mb-1">{b.lang}</div>}
        <code>{b.lines.join("\n") || " "}</code>
      </pre>
    );
  }
  if (b.kind === "frontmatter") {
    return (
      <details
        key={idx}
        className="md-frontmatter rounded-box border border-base-300 bg-base-200 group"
      >
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-base-content/70 select-none flex items-center gap-1">
          <span className="inline-block transition-transform group-open:rotate-90">›</span>
          config
        </summary>
        <pre className="px-3 pb-3 pt-0 overflow-x-auto text-sm font-mono">
          <code>{b.lines.join("\n") || " "}</code>
        </pre>
      </details>
    );
  }
  if (b.kind === "list") {
    const Tag = b.ordered ? "ol" : "ul";
    return (
      <Tag
        key={idx}
        className={`md-list pl-6 space-y-1 ${b.ordered ? "list-decimal" : "list-disc"}`}
      >
        {b.items.map((item, j) => (
          <li key={j}>{renderInline(item)}</li>
        ))}
      </Tag>
    );
  }
  if (b.kind === "quote") {
    return (
      <blockquote
        key={idx}
        className="md-quote border-l-4 border-primary/40 pl-4 italic text-base-content/80"
      >
        {b.lines.map((l, j) => (
          <div key={j}>{renderInline(l) || " "}</div>
        ))}
      </blockquote>
    );
  }
  return (
    <p key={idx} className="md-para">
      {b.lines.map((l, j) => (
        <span key={j}>
          {renderInline(l)}
          {j < b.lines.length - 1 && " "}
        </span>
      ))}
    </p>
  );
}

function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6, text: string, key: number): React.ReactNode {
  const inline = renderInline(text);
  const baseUnderline = "border-b border-base-300 pb-1";
  if (level === 1) {
    return (
      <h1 key={key} className={`md-h md-h1 text-3xl font-bold mt-4 ${baseUnderline}`}>
        {inline}
      </h1>
    );
  }
  if (level === 2) {
    return (
      <h2 key={key} className={`md-h md-h2 text-2xl font-semibold mt-4 ${baseUnderline}`}>
        {inline}
      </h2>
    );
  }
  if (level === 3) {
    return (
      <h3 key={key} className={`md-h md-h3 text-lg font-semibold mt-3 ${baseUnderline}`}>
        {inline}
      </h3>
    );
  }
  if (level === 4) {
    return (
      <h4 key={key} className={`md-h md-h4 text-base font-bold mt-2 ${baseUnderline}`}>
        {inline}
      </h4>
    );
  }
  if (level === 5) {
    return (
      <h5
        key={key}
        className={`md-h md-h5 text-sm font-bold uppercase tracking-wide mt-2 ${baseUnderline}`}
      >
        {inline}
      </h5>
    );
  }
  return (
    <h6
      key={key}
      className={`md-h md-h6 text-xs font-bold uppercase tracking-wider opacity-80 mt-2 ${baseUnderline}`}
    >
      {inline}
    </h6>
  );
}

/** Allow only http(s) hrefs — drops `javascript:` / `data:` and other
 *  schemes that could sneak in via rendered (e.g. webhook-derived) content. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function renderInline(line: string): React.ReactNode {
  if (!line) {
    return "";
  }
  const parts: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let key = 0;
  for (const m of line.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      parts.push(line.slice(last, idx));
    }
    const tok = m[0];
    if (tok.startsWith("`")) {
      parts.push(
        <code key={key++} className="md-code px-1 rounded bg-base-200 text-sm font-mono">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      parts.push(
        <strong key={key++} className="md-bold font-semibold">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const safe = linkMatch ? safeHref(linkMatch[2] ?? "") : null;
      if (linkMatch && safe) {
        parts.push(
          <a
            key={key++}
            href={safe}
            className="md-link text-info underline"
            target="_blank"
            rel="noreferrer"
          >
            {linkMatch[1]}
          </a>,
        );
      } else if (linkMatch) {
        // Unsafe / non-http scheme — show the link text, drop the href.
        parts.push(linkMatch[1]);
      } else {
        parts.push(tok);
      }
    } else {
      const inner = tok.slice(1, -1);
      parts.push(
        <em key={key++} className="md-emph italic">
          {inner}
        </em>,
      );
    }
    last = idx + tok.length;
  }
  if (last < line.length) {
    parts.push(line.slice(last));
  }
  return parts;
}
