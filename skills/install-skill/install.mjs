// Download a skill and its supporting assets from GitHub.
// Usage: node install.mjs <owner/repo> <skill-name> [target-dir]
// Works with Node 18+ and Bun.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const repo = process.argv[2];
const skillName = process.argv[3];
const targetDir = process.argv[4] || join(process.cwd(), "skills");

if (!repo || !skillName) {
  console.log(JSON.stringify({ error: "Usage: node install.mjs <owner/repo> <skill-name> [target-dir]" }));
  process.exit(1);
}

const headers = { "User-Agent": "errandd-skill-installer" };

function safeName(name) {
  return typeof name === "string" && name !== "." && name !== ".." && name.length > 0 && !/[\\/]/.test(name);
}

async function downloadDirectory(files, destDir, prefix = "") {
  mkdirSync(destDir, { recursive: true });
  const downloaded = [];
  for (const file of files) {
    if (!safeName(file.name)) throw new Error("Invalid skill asset name");
    const relativeName = `${prefix}${file.name}`;
    const filePath = join(destDir, file.name);
    if (file.type === "dir") {
      const res = await fetch(file.url, { headers });
      if (!res.ok) throw new Error(`Cannot list ${relativeName}: HTTP ${res.status}`);
      const children = await res.json();
      if (!Array.isArray(children)) throw new Error(`Invalid directory listing for ${relativeName}`);
      downloaded.push(...await downloadDirectory(children, filePath, `${relativeName}/`));
    } else if (file.type === "file") {
      const raw = await fetch(file.download_url, { headers });
      if (!raw.ok) throw new Error(`Cannot download ${relativeName}: HTTP ${raw.status}`);
      writeFileSync(filePath, new Uint8Array(await raw.arrayBuffer()));
      downloaded.push(relativeName);
    }
  }
  return downloaded;
}

try {
  if (!safeName(skillName) || !/^[^/\\]+\/[^/\\]+$/.test(repo)) {
    throw new Error("Expected owner/repo and a single skill directory name");
  }
  let res = await fetch(`https://api.github.com/repos/${repo}/contents/skills/${encodeURIComponent(skillName)}`, { headers });
  if (res.status === 404) {
    // Some repositories keep skill directories at their root.
    res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(skillName)}`, { headers });
  }
  if (!res.ok) throw new Error(`Cannot find skill ${skillName} in ${repo}: HTTP ${res.status}`);
  const listing = await res.json();
  const files = Array.isArray(listing) ? listing : [listing];
  const destDir = join(targetDir, skillName);
  const downloaded = await downloadDirectory(files, destDir);

  console.log(JSON.stringify({
    ok: true,
    skill: skillName,
    source: repo,
    path: destDir,
    files: downloaded,
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
}
