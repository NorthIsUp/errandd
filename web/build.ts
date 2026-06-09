import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const outRoot = "dist/web";
await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

// Pre-process Tailwind CSS for any bundle that uses @import "tailwindcss"
// (Bun can't handle the @import natively, so we run the standalone CLI).
const twBin = join("node_modules", ".bin", "tailwindcss");
const twJobs: { in: string; out: string }[] = [
  { in: "web/ui/styles.css", out: "web/ui/styles.gen.css" },
  { in: "web/v3/styles.css", out: "web/v3/styles.gen.css" },
];
for (const job of twJobs) {
  const r = spawnSync(twBin, ["-i", job.in, "-o", job.out], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(`Tailwind CSS build failed for ${job.in}:`, r.stderr);
    process.exit(1);
  }
}

interface Bundle {
  /** Subdir under dist/web/ */
  name: string;
  /** Entrypoint file */
  entry: string;
  /** HTML template path */
  html: string;
}

const bundles: Bundle[] = [
  // v3 is the default UI; the legacy "ui" bundle is kept at /v2/ because v3
  // reuses its Settings/About sections. The old darwin/os9/osish bundles were
  // frozen dead-on-the-vine parallel UIs and have been removed.
  { name: "v2", entry: "web/ui/index.tsx", html: "web/ui/index.html" },
  { name: "v3", entry: "web/v3/index.tsx", html: "web/v3/index.html" },
];

for (const bundle of bundles) {
  const outdir = `${outRoot}/${bundle.name}`;
  await mkdir(outdir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [bundle.entry],
    outdir,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: process.env.NODE_ENV === "production",
    naming: { chunk: "[name]-[hash].[ext]" },
    loader: { ".css": "css" },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const jsOut = result.outputs.find((o) => o.path.endsWith(".js"));
  const cssOut = result.outputs.find((o) => o.path.endsWith(".css"));
  if (jsOut) await rename(jsOut.path, `${outdir}/app.js`);
  if (cssOut) await rename(cssOut.path, `${outdir}/app.css`);

  const html = await readFile(bundle.html, "utf8");
  await writeFile(`${outdir}/index.html`, html, "utf8");

  console.log(`built ${outdir}/`);
  console.log(`  index.html`);
  if (jsOut) console.log(`  app.js`);
  if (cssOut) console.log(`  app.css`);

  // Copy gitignored asset folders (e.g. user-supplied icons) into the bundle
  // so the daemon can serve them at /<bundle>/<folder>/<file>.
  const assetFolders = [`web/${bundle.name}/icons`];
  for (const src of assetFolders) {
    try {
      const s = await stat(src);
      if (!s.isDirectory()) continue;
      const dst = `${outdir}/${src.split("/").pop()}`;
      await cp(src, dst, { recursive: true });
      const entries = await readdir(dst);
      if (entries.length > 0) {
        console.log(`  ${src.split("/").pop()}/ (${entries.length} files)`);
      }
    } catch {
      // src missing — fine, user just hasn't dropped files in yet.
    }
  }
}
