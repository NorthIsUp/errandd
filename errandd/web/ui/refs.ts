/**
 * Reference extraction for chat messages.
 *
 * v1 sources: GitHub PRs (URL + `org/repo#N` shorthand) and Linear tickets
 * (URL + bare `TEAM-123`). Each ref carries enough info to render a clickable
 * pill and a stable de-dup key.
 */

export type RefKind = "pr" | "linear";

export interface Ref {
  kind: RefKind;
  label: string;
  href: string;
  /** Stable de-dup key across messages in the same session. */
  key: string;
}

const PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

// `org/repo#123` — guard with word boundaries so we don't match inside e.g.
// "foo/bar.md#section-3" or "auth/login#L42". Repo name disallows leading dot.
const PR_SHORT_RE =
  /(?:^|[\s([])([a-zA-Z0-9_][\w.-]*\/[a-zA-Z0-9_][\w.-]*)#(\d+)(?=$|[\s.,;:!?)\]])/g;

const LINEAR_URL_RE = /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]+-\d+)/g;

// Bare `TEAM-1234`. Require an upper-case team code (2+ chars) followed by
// a hyphen and digits. Use lookbehind via leading boundary to avoid matching
// the middle of a string.
const LINEAR_BARE_RE = /(?:^|[\s([])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?=$|[\s.,;:!?)\]])/g;

export function extractRefs(text: string): Ref[] {
  if (!text) {
    return [];
  }
  const out: Ref[] = [];

  for (const m of text.matchAll(PR_URL_RE)) {
    const [, org, repo, num] = m;
    out.push({
      kind: "pr",
      label: `${org}/${repo}#${num}`,
      href: `https://github.com/${org}/${repo}/pull/${num}`,
      key: `pr:${org}/${repo}#${num}`,
    });
  }

  for (const m of text.matchAll(PR_SHORT_RE)) {
    const [, slug, num] = m;
    out.push({
      kind: "pr",
      label: `${slug}#${num}`,
      href: `https://github.com/${slug}/pull/${num}`,
      key: `pr:${slug}#${num}`,
    });
  }

  for (const m of text.matchAll(LINEAR_URL_RE)) {
    const id = m[1];
    if (!id) {
      continue;
    }
    out.push({
      kind: "linear",
      label: id,
      href: m[0],
      key: `linear:${id}`,
    });
  }

  for (const m of text.matchAll(LINEAR_BARE_RE)) {
    const [, team, num] = m;
    const id = `${team}-${num}`;
    out.push({
      kind: "linear",
      label: id,
      // Without a workspace slug we can only go to the issue search; the URL
      // form lands you on the issue directly via Linear's redirect.
      href: `https://linear.app/issue/${id}`,
      key: `linear:${id}`,
    });
  }

  return out;
}

export function dedupRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const r of refs) {
    if (seen.has(r.key)) {
      continue;
    }
    seen.add(r.key);
    out.push(r);
  }
  return out;
}
