import {
  AuiIf,
  ComposerPrimitive,
  groupPartByType,
  MessagePrimitive,
  MessagePartPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useAgUiInterrupts } from "@assistant-ui/react-ag-ui";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { ComponentProps } from "react";
import { ArrowDown, Info } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  NOTICE_ACTIVITY,
  noticeSchema,
  SOURCES_ACTIVITY,
  sourcesSchema,
} from "../../shared/chatAnnotations";
import { hookOrigin, hookSenderMetadataSchema } from "../../shared/hookOrigin";
import { MessageSender } from "./MessageSender";
import { JOB_ACTIVITY } from "../../shared/workflowCards";
import { JobActivity, SubagentCard, ReviewReportCard, ReviewDecisionCard } from "./workflowCards";
import { webhookDisplayMarkdown } from "../../shared/webhookDisplay";
import { DiffHighlighter, diffMarkdownComponents } from "./diffMarkdown";
import { CopyButton } from "../components/CopyButton";
import { RoutineDocument } from "../components/RoutineDocument";
import { routineDocument } from "../../shared/routineDocument";
import {
  AssistantRoutineCard,
  AssistantToolCard,
  AssistantThoughtGroup,
  AssistantReasoningCard,
} from "./toolCards";
import "./styles.css";

// Parse GitHub comment HTML before applying the GitHub-style allowlist.
// Keep the pipeline identical for ordinary messages and activity bodies.
const markdownPlugins = [remarkGfm];
const htmlPlugins: NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]> = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      attributes: {
        ...defaultSchema.attributes,
        source: [...(defaultSchema.attributes?.source ?? []), "media", "type"],
      },
    },
  ],
];

function Markdown({ text }: { text: string }) {
  const role = useAuiState((state) => state.message.role);
  const document = role === "user" ? routineDocument(text) : null;
  if (document) return (
    <>
      <div className="aui-demo-text-box">
        <CopyButton text={webhookDisplayMarkdown(document.context)} label="hook context" />
        <ReactMarkdown components={diffMarkdownComponents} remarkPlugins={markdownPlugins} rehypePlugins={htmlPlugins}>
          {webhookDisplayMarkdown(document.context)}
        </ReactMarkdown>
      </div>
      <RoutineDocument title={document.title} markdown={document.body}>
        <ReactMarkdown components={diffMarkdownComponents} remarkPlugins={markdownPlugins} rehypePlugins={htmlPlugins}>
          {document.content}
        </ReactMarkdown>
      </RoutineDocument>
    </>
  );
  return (
    <div className="aui-demo-text-box">
      <CopyButton text={role === "user" ? webhookDisplayMarkdown(text) : text} label="message" />
      <MarkdownTextPrimitive
        className="aui-demo-markdown"
        remarkPlugins={markdownPlugins}
        rehypePlugins={htmlPlugins}
        components={{ SyntaxHighlighter: DiffHighlighter }}
        smooth={false}
        preprocess={(text) => (role === "user" ? webhookDisplayMarkdown(text) : text)}
      />
    </div>
  );
}

function Activity({ name, data }: { name: string; data: unknown }) {
  if (name === `agui-activity/${JOB_ACTIVITY}`) return <JobActivity data={data} />;
  if (name === `agui-activity/${NOTICE_ACTIVITY}`) {
    const parsed = noticeSchema.safeParse(data);
    if (!parsed.success) {
      return null;
    }
    const content = parsed.data;
    if (content.kind === "fyi")
      return (
        <aside className="aui-fyi-notice" role="note" aria-label="FYI — not sent to the agent">
          <Info size={17} aria-hidden="true" />
          <div>
            <header>
              <strong>FYI</strong>
              <span>Not sent to the agent</span>
            </header>
            <ReactMarkdown
              components={diffMarkdownComponents}
              remarkPlugins={markdownPlugins}
              rehypePlugins={htmlPlugins}
            >
              {content.body}
            </ReactMarkdown>
          </div>
        </aside>
      );
    return (
      <section className="demo-activity" data-kind={content.kind}>
        <header>
          <strong>{content.title}</strong>
          {content.at != null && (
            <time dateTime={new Date(content.at).toISOString()}>
              {new Date(content.at).toLocaleString()}
            </time>
          )}
          {content.href && (
            <a href={content.href} target="_blank" rel="noreferrer">
              Original ↗
            </a>
          )}
        </header>
        <ReactMarkdown
          components={diffMarkdownComponents}
          remarkPlugins={markdownPlugins}
          rehypePlugins={htmlPlugins}
        >
          {content.body}
        </ReactMarkdown>
      </section>
    );
  }
  if (name === `agui-activity/${SOURCES_ACTIVITY}`) {
    const parsed = sourcesSchema.safeParse(data);
    if (!parsed.success) {
      return null;
    }
    return (
      <nav className="demo-activity-sources" aria-label="Capture references">
        <span>Sources</span>
        {parsed.data.links.map((link) => (
          <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
            {link.label} ↗
          </a>
        ))}
      </nav>
    );
  }
  return null;
}

const groupThoughts = groupPartByType({
  reasoning: ["group-thought"],
  "tool-call": ["group-thought"],
  "tool-call:inspect_routine": [],
  "tool-call:delegate_review": [],
  "tool-call:review_report": [],
  "tool-call:review_decision": [],
});

function Message() {
  const role = useAuiState((state) => state.message.role);
  const metadata = useAuiState((state) => state.message.metadata.custom.errandd);
  const text = useAuiState(
    (state) => state.message.parts.find((part) => part.type === "text")?.text ?? "",
  );
  const sender = hookSenderMetadataSchema.safeParse(metadata);
  const origin = role === "user" ? (sender.success ? sender.data.origin : hookOrigin(text)) : null;
  return (
    <MessagePrimitive.Root
      className="aui-demo-message"
      data-role={role}
      data-origin={origin?.provider}
      data-has-document={role === "user" && routineDocument(text) != null ? true : undefined}
    >
      {origin && <MessageSender origin={origin} />}
      <MessagePrimitive.GroupedParts groupBy={groupThoughts}>
        {({ part, children }) => {
          switch (part.type) {
            case "group-thought":
              return <AssistantThoughtGroup>{children}</AssistantThoughtGroup>;
            case "text":
              return <Markdown text={part.text} />;
            case "reasoning":
              return <AssistantReasoningCard text={part.text} />;
            case "tool-call":
              if (part.toolUI) return part.toolUI;
              if (part.toolName === "delegate_review")
                return (
                  <SubagentCard {...part}>
                    <MessagePartPrimitive.Messages
                      components={{
                        UserMessage: Message,
                        AssistantMessage: Message,
                        SystemMessage: Message,
                      }}
                    />
                  </SubagentCard>
                );
              if (part.toolName === "review_report") return <ReviewReportCard {...part} />;
              if (part.toolName === "review_decision") return <ReviewDecisionCard {...part} />;
              return part.toolName === "inspect_routine" ? (
                <AssistantRoutineCard {...part} />
              ) : (
                <AssistantToolCard {...part} />
              );
            case "image":
              return <MessagePartPrimitive.Image className="aui-demo-image" />;
            case "indicator":
              return (
                <span className="aui-demo-thinking" role="status">
                  Working…
                </span>
              );
            case "data":
              return part.dataRendererUI ?? <Activity {...part} />;
            default:
              return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
      <MessagePrimitive.Error />
    </MessagePrimitive.Root>
  );
}

/** Standard framework primitives own message state, composing, streaming,
 * scrolling, copy and cancellation. App code supplies layout and part slots. */
export function AssistantThread({
  readOnly = false,
  welcomeMessage = "What would you like to work on?",
  suggestions = [],
}: {
  readOnly?: boolean;
  welcomeMessage?: string;
  suggestions?: string[];
}) {
  const paused = useAgUiInterrupts().length > 0;
  return (
    <ThreadPrimitive.Root className="aui-demo-thread">
      <ThreadPrimitive.Viewport className="aui-demo-viewport" autoScroll={!readOnly}>
        <ThreadPrimitive.Empty>
          <p className="aui-demo-welcome">{welcomeMessage}</p>
          {suggestions.length > 0 && (
            <div className="aui-demo-suggestions">
              {suggestions.map((prompt) => (
                <ThreadPrimitive.Suggestion
                  key={prompt}
                  prompt={prompt}
                  autoSend
                  className="aui-demo-suggestion"
                >
                  {prompt}
                </ThreadPrimitive.Suggestion>
              ))}
            </div>
          )}
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{ UserMessage: Message, AssistantMessage: Message, SystemMessage: Message }}
        />
      </ThreadPrimitive.Viewport>
      {!readOnly && (
        <ThreadPrimitive.ScrollToBottom
          className="aui-demo-scroll-bottom"
          aria-label="Jump to latest"
        >
          <ArrowDown size={16} aria-hidden="true" />
        </ThreadPrimitive.ScrollToBottom>
      )}
      {readOnly ? (
        <p className="comparison-readonly">
          Captured transcript · tools and messages are not executed.
        </p>
      ) : (
        <ComposerPrimitive.Root className="aui-demo-composer">
          <ComposerPrimitive.Input
            placeholder={
              paused ? "Respond to the pending request above" : "Ask about your errands…"
            }
            aria-label="Message"
            disabled={paused}
          />
          <AuiIf condition={(state) => !state.thread.isRunning}>
            <ComposerPrimitive.Send disabled={paused}>Send</ComposerPrimitive.Send>
          </AuiIf>
          <AuiIf condition={(state) => state.thread.isRunning}>
            <ComposerPrimitive.Cancel>Stop</ComposerPrimitive.Cancel>
          </AuiIf>
        </ComposerPrimitive.Root>
      )}
    </ThreadPrimitive.Root>
  );
}
