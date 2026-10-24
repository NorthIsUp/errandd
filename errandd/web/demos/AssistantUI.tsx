import { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import { useEffect, useMemo, useState } from "react";
import { toAnnotatedMessages } from "../../shared/chatAnnotations";
import { type ChatExamples, displayExamples, toStockMessages } from "../../shared/chatExamples";
import { getApiToken } from "../api/client";
import { WorkflowInspector } from "../chat/workflowCards";
import { AssistantThread } from "../chat/AssistantThread";
import { toAssistantMessages } from "./assistantMessages";
export { AssistantThread } from "../chat/AssistantThread";
export function AssistantTranscript({
  data,
  selection,
  compact = false,
  annotated = true,
}: {
  data: ChatExamples;
  selection: string;
  compact?: boolean;
  annotated?: boolean;
}) {
  const messages = useMemo(
    () =>
      toAssistantMessages(
        (annotated ? toAnnotatedMessages : toStockMessages)(
          displayExamples(
            selection === "composite"
              ? data.examples
              : data.examples.filter((example) => example.id === selection),
            compact,
          ),
        ),
      ),
    [data, selection, compact, annotated],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning: false,
    isDisabled: true,
    onNew: () => {
      throw new Error("Captured chats are read-only");
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AssistantThread readOnly />
    </AssistantRuntimeProvider>
  );
}

function Interactive({ live }: { live: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [agent] = useState(() => {
    const token = getApiToken();
    return new HttpAgent({
      url: live ? "/api/agui" : "/api/demos/agui",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  });
  const runtime = useAgUiRuntime({ agent, onError: (failure) => setError(failure.message) });
  useEffect(() => {
    const subscription = agent.subscribe({ onRunStartedEvent: () => setError(null) });
    return () => subscription.unsubscribe();
  }, [agent]);
  return (
    <>
      <p className="demo-note">
        {live
          ? "Live agent · messages run your configured CLI agent."
          : "Scripted preview · no model calls or job runs."}
      </p>
      {error && (
        <p role="alert" className="demo-error">
          {error}
        </p>
      )}
      <div className="assistant-interactive">
        <AssistantRuntimeProvider runtime={runtime}>
          {!live && <WorkflowInspector />}
          <AssistantThread
            suggestions={
              live
                ? []
                : ["Review a webhook with subagents", "Show cards and Bash details", "/error"]
            }
            welcomeMessage={
              live
                ? "What would you like to work on?"
                : "Ask about an errand to try streaming, tools, and Markdown. Send /error to test failure handling."
            }
          />
        </AssistantRuntimeProvider>
      </div>
    </>
  );
}

export function AssistantDemo({ live }: { live: boolean }) {
  const [conversation, setConversation] = useState(0);
  return (
    <div className="demo-shell">
      <header className="demo-header">
        <a className="demo-brand" href="/demos/chat">
          errandd <span>/ assistant-ui</span>
        </a>
        <nav aria-label="Demo navigation">
          <a href="/demos/chat/compare">Captured chats</a>
          <a href={`/demos/chat/assistant-ui?mode=${live ? "scripted" : "live"}`}>
            {live ? "Use scripted preview" : "Use live agent"}
          </a>
          <a href="/demos/chat/cards">Custom cards</a>
        </nav>
      </header>
      <section className="demo-toolbar">
        <h1>assistant-ui · native AG-UI runtime</h1>
        <button type="button" onClick={() => setConversation((value) => value + 1)}>
          New chat
        </button>
      </section>
      <Interactive key={`${live}-${conversation}`} live={live} />
    </div>
  );
}
