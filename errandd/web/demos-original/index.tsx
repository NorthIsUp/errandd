import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { displayExamples, type ChatExamples } from "../../shared/chatExamples";
import { apiFetch } from "../api/client";
import { CUSTOM_CARD_EXAMPLES } from "../demos/customCardExamples";
import { PartList } from "../v3/components/parts/PartList";
import { SourcesPart } from "../v3/components/parts/SourcesPart";
import "../v3/styles.gen.css";
import "./styles.css";

function OriginalTranscript() {
  const [selection] = useState(() => new URLSearchParams(location.search).get("example") || "composite");
  const [compact] = useState(() => new URLSearchParams(location.search).get("compact") !== "0");
  const [data, setData] = useState<ChatExamples | null>(() => selection === "custom-cards" ? CUSTOM_CARD_EXAMPLES : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (selection === "custom-cards") return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch("/api/demos/chat-examples", { signal: abort.signal });
        if (!response.ok) throw new Error(`Capture request failed (${response.status})`);
        const result = (await response.json()) as ChatExamples;
        if (!abort.signal.aborted) setData(result);
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => abort.abort();
  }, [selection]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>Loading captured transcript…</p>;
  const examples =
    selection === "custom-cards"
      ? CUSTOM_CARD_EXAMPLES.examples
      : selection === "composite"
        ? data.examples
        : data.examples.filter((example) => example.id === selection);
  return (
    <main className="original-transcript">
      {displayExamples(examples, compact).map((example, index) => (
        <section key={example.id} className="original-capture">
          <header>
            <span>Capture {index + 1}</span>
            <h2>{example.title}</h2>
            <a href={example.sourceUrl} target="_blank" rel="noreferrer">
              Original conversation ↗
            </a>
          </header>
          <PartList parts={example.parts} />
          {example.sources.length > 0 && (
            <footer>
              <p>References extracted from this capture</p>
              <SourcesPart sources={example.sources} />
            </footer>
          )}
        </section>
      ))}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<OriginalTranscript />);

import "../styles/field-notes.css";
