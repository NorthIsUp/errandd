import { useState } from "react";
import { AssistantDemo } from "./AssistantUI";
import { Comparison } from "./Comparison";

const EXAMPLES = [
  {
    href: "/demos/chat/assistant-ui",
    title: "Interactive assistant-ui",
    description:
      "Live job cards, nested subagents, review decisions, state sync, reports, Bash rows, Markdown/HTML and follow-ups. A local scripted backend runs no commands or models.",
  },
  {
    href: "/demos/chat/compare",
    title: "Real captured conversations",
    description:
      "Our current renderer beside assistant-ui, using the same complex production captures and provider messages.",
  },
  {
    href: "/demos/chat/cards",
    title: "Custom cards & Bash details",
    description:
      "Named commenters, JSON output, FYI notices and diff formats, alongside our routine cards and Bash details.",
  },
];

export function App() {
  const [route] = useState(() => ({
    path: location.pathname.replace(/\/$/, ""),
    mode: new URLSearchParams(location.search).get("mode"),
  }));
  if (route.path.endsWith("/chat/compare") || route.mode === "captures") return <Comparison />;
  if (route.path.endsWith("/chat/cards")) return <Comparison initialExample="custom-cards" />;
  if (route.path !== "/demos/chat" && route.path !== "/demos")
    return <AssistantDemo live={route.mode === "live"} />;
  return (
    <div className="demo-shell">
      <header className="demo-header">
        <a className="demo-brand" href="/demos/chat">
          errandd <span>/ chat demos</span>
        </a>
        <nav aria-label="Demo navigation">
          <a href="/v3/">Dashboard</a>
          <a
            href="https://www.assistant-ui.com/docs/runtimes/ag-ui/overview"
            target="_blank"
            rel="noreferrer"
          >
            assistant-ui docs ↗
          </a>
        </nav>
      </header>
      <main className="demo-gallery">
        <p className="demo-eyebrow">assistant-ui + local Errandd backend</p>
        <h1>
          Our conversations.
          <br />
          Framework-owned chat.
        </h1>
        <p className="demo-lead">
          assistant-ui handles chat state, streaming, scrolling and the composer. Our existing tool
          rail and small custom cards keep the useful Errandd UX.
        </p>
        <div className="demo-mode">
          <strong>Scripted preview</strong>
          <span>Safe by default: no model calls, commands or job runs.</span>
          <a href="/demos/chat/assistant-ui?mode=live">Use live agent →</a>
        </div>
        <div className="demo-cards">
          {EXAMPLES.map((example, index) => (
            <a key={example.href} href={example.href} className="demo-card">
              <span className="demo-number">0{index + 1}</span>
              <h2>{example.title}</h2>
              <p>{example.description}</p>
              <span className="demo-open">Open example →</span>
            </a>
          ))}
        </div>
        <p className="demo-note">
          These are integration demos. The Errandd dashboard remains the application.
        </p>
      </main>
    </div>
  );
}
