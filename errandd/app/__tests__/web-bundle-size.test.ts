// The v3 bundle was 10.4MB because one import (`codeToHtml` from "shiki")
// dragged in 634 grammars and every theme. Nothing failed — it just shipped.
// These two guards exist so the next person to reach for a convenience import
// finds out at test time rather than from a slow dashboard.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..");
const webSrc = join(repo, "web");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("web bundle weight", () => {
  test("nothing imports the full shiki bundle", async () => {
    const offenders: string[] = [];
    for (const f of tsFiles(webSrc)) {
      const src = await Bun.file(f).text();
      // `shiki/core`, `@shikijs/langs/*` etc. are fine — only bare "shiki"
      // (and its all-inclusive bundle entrypoints) pull every grammar.
      // Anchored to a real import/export statement: highlighter.ts *discusses*
      // `from "shiki"` in a comment, and prose is not a dependency.
      const bad = /^\s*(?:import|export)\b[^\n]*?from\s+["'](?:shiki|shiki\/bundle\/(?:full|web))["']/m;
      if (bad.test(src)) {
        offenders.push(f.slice(repo.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  // Only meaningful after a build; `bun test` alone shouldn't require one.
  test.skipIf(!existsSync(join(repo, "dist/web/v3/app.js")))(
    "built v3 app.js stays under the size ceiling",
    () => {
      const bytes = statSync(join(repo, "dist/web/v3/app.js")).size;
      const mb = bytes / 1024 / 1024;
      // The ceiling has to hold whether or not the build was minified, because
      // only the Dockerfile sets NODE_ENV=production — the pre-push hook and a
      // local `bun run build:web` do not, and minify is gated on it:
      //   curated, minified ....  2.75MB
      //   curated, unminified ..  4.95MB   <- hook/local builds land here
      //   full shiki, minified . 10.38MB   <- the regression being guarded
      // 7MB sits between the worst legitimate case and the best bad one.
      expect(mb).toBeLessThan(7);
    }
  );
});
