import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RepositoryAnalysisMessage } from "./RepositoryAnalysisMessage";

test("repository evidence uses the shared document card with one timestamp, Markdown and copy action", () => {
  const html = renderToStaticMarkup(<RepositoryAnalysisMessage text={"## Repository evidence\n\n| Package | Version |\n| --- | --- |\n| pypdf | 6.21.4 |"} at={1793548800000} />);
  expect(html).toContain('aria-label="Repository pre-analysis"');
  expect(html).toContain("preliminary lockfile analysis");
  expect(html).toContain("<table");
  expect(html.match(/<time/g)).toHaveLength(1);
  expect(html).toContain("Copy");
});
