/**
 * Gitops plugin manifest (errandd/plugins.json) — no network.
 * Verifies the manifest declares the required defaults and that the config
 * default jobsRepos (no user override) is sourced from it.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { DEFAULT_JOBS_REPOS } from "../config";

const REQUIRED = [
  "errandd-jobs",
  "skillz",
  "superpowers-marketplace",
  "anthropics/skills",
  "cursor-plugins-claude",
];

test("plugins.json declares the required default marketplaces + jobs repos", () => {
  const raw = readFileSync(fileURLToPath(new URL("../../plugins.json", import.meta.url)), "utf-8");
  const manifest = JSON.parse(raw) as { marketplaces: string[]; jobsRepos: string[] };
  const urls = [...manifest.marketplaces, ...manifest.jobsRepos];
  for (const needle of REQUIRED) {
    expect(urls.some((u) => u.includes(needle))).toBe(true);
  }
});

test("config default jobsRepos includes the errandd-jobs repo", () => {
  expect(DEFAULT_JOBS_REPOS.some((r) => r.url.includes("errandd-jobs"))).toBe(true);
});
