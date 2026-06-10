import { cn } from "../ui/utils"
import { marked } from "marked"
import { memo, useId, useMemo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { CodeBlock, CodeBlockCode } from "./code-block"
import { Source, SourceContent, SourceTrigger } from "./source"

/** Flatten a react-markdown link's children to plain text (for bare-URL detection). */
function linkText(children: React.ReactNode): string | null {
  if (typeof children === "string") return children
  if (Array.isArray(children) && children.every((c) => typeof c === "string")) {
    return children.join("")
  }
  return null
}

/** A bare-URL link (visible text === the href) reads as a *reference*, so render
 *  it as a compact source bubble (favicon + a meaningful id, full URL on hover)
 *  instead of a long raw link. Labeled links ([text](url)) stay as text links. */
function isBareUrl(href: string, children: React.ReactNode): boolean {
  if (!/^https?:\/\//i.test(href)) return false
  const text = linkText(children)?.trim()
  return text != null && (text === href || text === href.replace(/\/+$/, ""))
}

/** A short, meaningful bubble label for known sources — the thing you'd actually
 *  reference — falling back to the domain (SourceTrigger's default) when unknown.
 *  Sentry → issue id; GitHub → `repo#n`; Linear → ticket id. */
function sourceLabel(url: string): string | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const host = u.hostname.replace(/^www\./, "")
  const parts = u.pathname.split("/").filter(Boolean)
  // Sentry: .../issues/<id>  (id may be a short slug like CLARA-BACKEND-QJ)
  if (host.endsWith("sentry.io")) {
    const i = parts.indexOf("issues")
    if (i >= 0 && parts[i + 1]) return parts[i + 1]
  }
  // GitHub: /<owner>/<repo>/(pull|issues)/<n> → repo#n
  if (host === "github.com" && parts.length >= 4 && (parts[2] === "pull" || parts[2] === "issues")) {
    return `${parts[1]}#${parts[3]}`
  }
  // Linear: .../issue/<TEAM-123>
  if (host.endsWith("linear.app")) {
    const i = parts.indexOf("issue")
    if (i >= 0 && parts[i + 1]) return parts[i + 1]
  }
  return undefined
}

export type MarkdownProps = {
  children: string
  id?: string
  className?: string
  components?: Partial<Components>
}

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown)
  return tokens.map((token) => token.raw)
}

function extractLanguage(className?: string): string {
  if (!className) return "plaintext"
  const match = className.match(/language-(\w+)/)
  return match?.[1] ?? "plaintext"
}

// Pick a shiki theme that matches the active v3 theme — github-light on the
// light themes, a dark theme everywhere else. Without this, code blocks render
// white-on-white inside the dark themes (the "white box" bug).
function shikiThemeForActive(): string {
  const t =
    typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-theme")
      : null
  const light = t === "tidepool" || t === "contrast-light"
  return light ? "github-light" : "github-dark-default"
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line

    if (isInline) {
      return (
        <span
          className={cn(
            "bg-base-200 text-base-content rounded-sm px-1 font-mono text-sm",
            className
          )}
          {...props}
        >
          {children}
        </span>
      )
    }

    const language = extractLanguage(className)

    return (
      <CodeBlock {...(className ? { className } : {})}>
        <CodeBlockCode
          code={children as string}
          language={language}
          theme={shikiThemeForActive()}
        />
      </CodeBlock>
    )
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>
  },

  // Prose elements, styled with daisy tokens so they theme for free across all
  // five v3 themes and read at chat density (tighter than article prose). This
  // replaces the inert `prose` class — markdown used to render structureless.
  // NB: the Markdown wrapper splits the body into one ReactMarkdown per block,
  // so `first:`/`last:` resets apply per-block (which is what we want for the
  // leading/trailing element of a message).
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-xl font-semibold text-base-content first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-lg font-semibold text-base-content first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-base font-semibold text-base-content/90 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1 text-sm font-semibold text-base-content/80 first:mt-0">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="my-2 leading-relaxed text-base-content/90 first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-2 ml-5 list-disc space-y-1 marker:text-primary/60">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 marker:text-base-content/40">{children}</ol>
  ),
  li: ({ children, ...props }) => {
    // GFM task-list items carry a `task-list-item` class + a checkbox child —
    // render those inline with no list marker.
    const isTask = (props as { className?: string }).className?.includes("task-list-item")
    return isTask ? (
      <li className="my-1 -ml-5 flex list-none items-start gap-2 leading-relaxed">{children}</li>
    ) : (
      <li className="my-1 leading-relaxed text-base-content/90">{children}</li>
    )
  },
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-primary/40 pl-3 text-base-content/70 italic">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => {
    const url = typeof href === "string" ? href : ""
    if (url && isBareUrl(url, children)) {
      const label = sourceLabel(url)
      return (
        <Source href={url}>
          <SourceTrigger
            showFavicon
            {...(label ? { label } : {})}
            className="-my-0.5 max-w-48 align-middle"
          />
          <SourceContent title={url} description={url} />
        </Source>
      )
    }
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {children}
      </a>
    )
  },
  strong: ({ children }) => <strong className="font-semibold text-base-content">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-4 border-base-300" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-base-300 px-2 py-1 text-left font-semibold text-base-content/80">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-base-300/60 px-2 py-1 text-base-content/80">{children}</td>
  ),
  input: (props) =>
    props.type === "checkbox" ? (
      <input {...props} disabled className="mt-1.5 accent-primary" />
    ) : (
      <input {...props} />
    ),
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string
    components?: Partial<Components>
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    )
  },
  function propsAreEqual(prevProps, nextProps) {
    return prevProps.content === nextProps.content
  }
)

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock"

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
}: MarkdownProps) {
  const generatedId = useId()
  const blockId = id ?? generatedId
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children])

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={components}
        />
      ))}
    </div>
  )
}

const Markdown = memo(MarkdownComponent)
Markdown.displayName = "Markdown"

export { Markdown }
