import { Fragment, type ReactNode, useMemo } from "react";
import { Decoration, Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { detectDiff, type DisplayDiff } from "../../shared/diffFormat";
import { CopyButton } from "./CopyButton";
import "./unified-diff.css";

export function UnifiedDiff({
  code,
  parsed,
  copyLabel = "diff",
}: {
  code: string;
  parsed: DisplayDiff;
  copyLabel?: string | null | undefined;
}) {
  const files = useMemo(() => {
    try {
      return parseDiff(parsed.patch);
    } catch {
      return [];
    }
  }, [parsed.patch]);
  if (!files.length) return <pre>{code}</pre>;
  return (
    <section
      className="errandd-unified-diff"
      aria-label="Unified diff"
      data-diff-format={parsed.format}
    >
      <header>
        <strong>{parsed.approximate ? "Diff snippet" : "Unified diff"}</strong>
        {copyLabel && <CopyButton text={code} label={copyLabel} />}
      </header>
      <div className="errandd-diff-scroll">
        {files.map((file, index) => (
          <div key={`${file.oldPath}:${file.newPath}:${index}`}>
            {file.newPath !== "changes" && (
              <div className="errandd-diff-file">
                {file.type === "rename"
                  ? `${file.oldPath} → ${file.newPath}`
                  : file.newPath || file.oldPath}
              </div>
            )}
            <Diff
              viewType="unified"
              diffType={file.type}
              hunks={file.hunks}
              gutterType={parsed.approximate ? "none" : "default"}
            >
              {(hunks) =>
                hunks.map((hunk) => (
                  <Fragment key={hunk.content}>
                    {!parsed.approximate && <Decoration>{hunk.content}</Decoration>}
                    <Hunk hunk={hunk} />
                  </Fragment>
                ))
              }
            </Diff>
          </div>
        ))}
      </div>
      <details className="errandd-diff-raw">
        <summary>Raw diff</summary>
        <pre>{code}</pre>
      </details>
    </section>
  );
}

/** Shared by assistant-ui, activity Markdown and the original renderer. */
export function DiffCodeBlock({
  code,
  language,
  children,
  copyLabel,
}: {
  code: string;
  language?: string | undefined;
  children?: ReactNode;
  copyLabel?: string | null | undefined;
}) {
  const parsed = useMemo(() => detectDiff(code, language), [code, language]);
  return parsed ? <UnifiedDiff code={code} parsed={parsed} copyLabel={copyLabel} /> : children;
}
