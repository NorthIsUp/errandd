import { useCallback, useEffect, useState } from "react";
import {
  createJobFile,
  deleteJobFile,
  getJobFile,
  writeJobFile,
} from "../api/jobs";

export interface ParsedFrontmatter {
  enabled: boolean;
  schedule: string;
  recurring: boolean;
  notify: boolean;
  /** Frontmatter keys outside the well-known set, preserved on save. */
  extra: Record<string, string>;
}

function emptyFm(): ParsedFrontmatter {
  return {
    enabled: true,
    schedule: "",
    recurring: false,
    notify: true,
    extra: {},
  };
}

export function parseFrontmatter(content: string): {
  fm: ParsedFrontmatter;
  body: string;
} {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(content);
  if (!match) return { fm: emptyFm(), body: content };
  const raw = match[1] ?? "";
  const body = match[2] ?? "";
  const fm = emptyFm();
  for (const line of raw.split("\n")) {
    const m = /^([a-z_]+):\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const val = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "enabled") fm.enabled = !/^(false|no|0|off)$/i.test(val);
    else if (key === "schedule") fm.schedule = val;
    else if (key === "recurring") fm.recurring = /^(true|yes|1|on)$/i.test(val);
    else if (key === "notify" || key === "notification")
      fm.notify = !/^(false|no|0|off)$/i.test(val);
    else fm.extra[key] = val;
  }
  return { fm, body };
}

export function serializeFrontmatter(
  fm: ParsedFrontmatter,
  body: string,
): string {
  const lines: string[] = ["---"];
  lines.push(`enabled: ${fm.enabled}`);
  if (fm.schedule) lines.push(`schedule: "${fm.schedule}"`);
  lines.push(`recurring: ${fm.recurring}`);
  lines.push(`notify: ${fm.notify}`);
  for (const [k, v] of Object.entries(fm.extra)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}${body.replace(/^\n+/, "")}`;
}

export function jobBaseName(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  return name.replace(/\.md$/, "");
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

export interface UseJobEditorResult {
  loading: boolean;
  saving: boolean;
  fm: ParsedFrontmatter | null;
  setFm: (fm: ParsedFrontmatter) => void;
  body: string;
  setBody: (body: string) => void;
  name: string;
  setName: (name: string) => void;
  save: (
    sanitize?: (name: string) => string,
  ) => Promise<{ ok: true; name: string } | { error: Error }>;
}

const DEFAULT_SANITIZE = (n: string) => n.trim().replace(/\.md$/i, "");

/**
 * Headless hook for editing a routine markdown file. Loads + parses the
 * frontmatter, exposes draft state, and persists (handling renames).
 */
export function useJobEditor(
  path: string,
  repoSlug: string | null,
): UseJobEditorResult {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fm, setFm] = useState<ParsedFrontmatter | null>(null);
  const [body, setBody] = useState("");
  const [name, setName] = useState(() => jobBaseName(path));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getJobFile(path, repoSlug);
        if (cancelled) return;
        const parsed = parseFrontmatter(res.content);
        setFm(parsed.fm);
        setBody(parsed.body);
        setName(jobBaseName(path));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, repoSlug]);

  const save = useCallback(
    async (sanitize: (n: string) => string = DEFAULT_SANITIZE) => {
      if (!fm) {
        return { error: new Error("Frontmatter not loaded yet") };
      }
      const cleaned = sanitize(name);
      if (!cleaned) {
        return { error: new Error("Name cannot be empty") };
      }
      setSaving(true);
      try {
        const content = serializeFrontmatter(fm, body);
        const originalName = jobBaseName(path);
        if (cleaned !== originalName) {
          const newPath = `${dirOf(path)}${cleaned}.md`;
          await createJobFile(newPath, repoSlug);
          await writeJobFile(newPath, content, repoSlug);
          await deleteJobFile(path, repoSlug);
        } else {
          await writeJobFile(path, content, repoSlug);
        }
        return { ok: true as const, name: cleaned };
      } catch (err) {
        return {
          error: err instanceof Error ? err : new Error(String(err)),
        };
      } finally {
        setSaving(false);
      }
    },
    [fm, body, name, path, repoSlug],
  );

  return { loading, saving, fm, setFm, body, setBody, name, setName, save };
}
