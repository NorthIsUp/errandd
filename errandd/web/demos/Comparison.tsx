import { useEffect, useState } from "react";
import { type ChatExamples, exampleMetrics } from "../../shared/chatExamples";
import { apiFetch } from "../api/client";
import { AssistantTranscript } from "./AssistantUI";
import { CUSTOM_CARD_EXAMPLES } from "./customCardExamples";

export function Comparison({
  initialData = null,
  initialExample,
}: {
  initialData?: ChatExamples | null;
  initialExample?: string;
}) {
  const [data, setData] = useState<ChatExamples | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState(() =>
    initialExample ?? (typeof location === "undefined"
      ? "composite"
      : (new URLSearchParams(location.search).get("example") ?? "composite")),
  );
  const [compact, setCompact] = useState(false);
  const [annotated, setAnnotated] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch("/api/demos/chat-examples", { signal: abort.signal });
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "No captures imported on this instance yet."
              : `Could not load captures (HTTP ${response.status})`,
          );
        }
        const result = (await response.json()) as ChatExamples;
        if (!abort.signal.aborted) {
          setData(result);
        }
      } catch (failure) {
        if (!abort.signal.aborted) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }
    })();
    return () => abort.abort();
  }, []);
  const shownData = selection === "custom-cards" ? CUSTOM_CARD_EXAMPLES : data;
  const shownSelection = selection === "custom-cards" ? "composite" : selection;
  const examples = shownData
    ? shownSelection === "composite"
      ? shownData.examples
      : shownData.examples.filter((example) => example.id === shownSelection)
    : [];
  const metrics = exampleMetrics(examples);
  return (
    <div className="demo-shell comparison-shell">
      <header className="demo-header">
        <a className="demo-brand" href="/demos/chat">
          errandd <span>/ real chat comparison</span>
        </a>
        <nav aria-label="Demo navigation">
          <a href="/demos/chat">All examples</a>
          <a href="/demos/chat/assistant-ui?mode=scripted">Try interactive chat · assistant-ui</a>
          <a href="/demos-original/">Original Errandd UX</a>
          <a href="/v3/">Dashboard</a>
        </nav>
      </header>
      <section className="comparison-intro">
        <p className="demo-eyebrow">
          {selection === "custom-cards"
            ? "Custom cards · synthetic · read-only"
            : "Production captures · read-only"}
        </p>
        <h1>Errandd UX with assistant-ui</h1>
        <p>
          The same captured chats in our current renderer and assistant-ui, with our tool rail and
          custom cards. The composite stitches separate conversations together for inspection; it is
          not one original conversation.
        </p>
        {data && (
          <div className="comparison-picker">
            <label htmlFor="capture">Conversation</label>
            <select
              id="capture"
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="composite">Composite · all {data.examples.length} captures</option>
              <option value="custom-cards">Custom cards · synthetic example</option>
              {data.examples.map((example) => (
                <option key={example.id} value={example.id}>
                  {example.title}
                </option>
              ))}
            </select>
            <label>
              <input
                type="checkbox"
                checked={annotated}
                onChange={(event) => setAnnotated(event.target.checked)}
              />{" "}
              AG-UI activity annotations
            </label>
            <label>
              <input
                type="checkbox"
                checked={compact}
                onChange={(event) => setCompact(event.target.checked)}
              />{" "}
              Shorten long plain text in both panes
            </label>
            <span>
              {metrics.parts} parts · {metrics.tools} tools · {metrics.errors} errors ·{" "}
              {metrics.fyi} FYI blocks
            </span>
          </div>
        )}
        {data && selection !== "custom-cards" && (
          <p className="demo-note">
            Source:{" "}
            <a href={data.sourceOrigin} target="_blank" rel="noreferrer">
              {new URL(data.sourceOrigin).hostname}
            </a>{" "}
            · captured {new Date(data.capturedAt).toLocaleString()} · stored locally, outside the
            bundle.
          </p>
        )}
        {selection === "custom-cards" && (
          <p className="demo-note">
            Synthetic custom-card example · no model calls, commands, or job runs. The assistant-ui
            pane uses a named tool slot for the custom routine card and reuses our existing Bash
            renderer.
          </p>
        )}
      </section>
      {error && !shownData && (
        <p role="alert" className="demo-error">
          {error}
        </p>
      )}
      {!(shownData ?? error) && (
        <p className="comparison-loading">Loading captured conversations…</p>
      )}
      {shownData && (
        <>
          <div className="comparison-panels">
            <section className="comparison-panel">
              <header>
                <h2>Current Errandd UX</h2>
                <p>The original renderer and tool rail.</p>
              </header>
              <iframe
                key={`${selection}-${compact}`}
                title="Current Errandd captured transcript"
                src={`/demos-original/?example=${encodeURIComponent(selection)}&compact=${compact ? "1" : "0"}`}
              />
            </section>
            <section className="comparison-panel">
              <header>
                <h2>assistant-ui</h2>
                <p>Stock AG-UI runtime and message primitives, with Errandd tool/card renderers.</p>
              </header>
              <div className="comparison-stock">
                <AssistantTranscript
                  key={`${selection}-${compact}-${annotated}`}
                  data={shownData}
                  selection={shownSelection}
                  compact={compact}
                  annotated={annotated}
                />
              </div>
            </section>
          </div>
          <section className="comparison-findings">
            <h2>What needs a small adapter?</h2>
            <div className="comparison-feature-grid">
              <article>
                <h3>Tool chains & narration</h3>
                <p>
                  {metrics.tools} calls. assistant-ui reuses the existing Errandd tool rail: compact
                  commands, status, expandable input/output, and automatic error expansion.
                </p>
              </article>
              <article>
                <h3>FYI / outside model context</h3>
                <p>
                  {metrics.fyi} blocks. The activity adapter preserves these as display-only AG-UI
                  activities, outside model context. Disable annotations to compare the basic
                  message mapping.
                </p>
              </article>
              <article>
                <h3>Failures & file edits</h3>
                <p>
                  {metrics.errors} tool errors and {metrics.edits} file edits. Small activity cards
                  restore error notices and edit diffs. The same tool component displays input,
                  output, errors, and call IDs in the assistant-ui pane.
                </p>
              </article>
              <article>
                <h3>References & reasoning</h3>
                <p>
                  {metrics.sources} extracted reference links; source chips need an app-level slot.{" "}
                  {metrics.reasoning
                    ? `${metrics.reasoning} reasoning blocks use the framework's reasoning message type.`
                    : "These captures contain no reasoning blocks, so that feature is not covered by this comparison."}
                </p>
              </article>
            </div>
            <div className="comparison-provenance">
              <h3>Capture provenance</h3>
              {examples.map((example) => (
                <p key={example.id}>
                  <a href={example.sourceUrl} target="_blank" rel="noreferrer">
                    {example.title} ↗
                  </a>{" "}
                  · {example.parts.length} of {example.totalParts} parts
                </p>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
