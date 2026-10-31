import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrStateIcon } from "./PrStateIcon";

test("merged PRs use the Git merge glyph, accessible status and stable violet color", () => {
  const html = renderToStaticMarkup(<PrStateIcon state="merged" />);
  expect(html).toContain('aria-label="PR state: Merged"');
  expect(html).toContain('title="PR state: Merged"');
  expect(html).toContain("lucide-git-merge");
  expect(html).toContain("text-violet-500");
  expect(html).not.toContain("text-secondary");
});
