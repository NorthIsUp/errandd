import type { HookOrigin } from "../../shared/hookOrigin";

/** Existing organization avatars; aliases cover service-account usernames.
 * Keys are compared case-insensitively, with an optional [bot] suffix removed. */
export const ACTOR_ICONS: Readonly<Record<string, { githubLogin: string; label: string }>> = {
  vercel: { githubLogin: "vercel", label: "Vercel" },
  "datadog-official": { githubLogin: "DataDog", label: "Datadog" },
  datadog: { githubLogin: "DataDog", label: "Datadog" },
  sentry: { githubLogin: "getsentry", label: "Sentry" },
  getsentry: { githubLogin: "getsentry", label: "Sentry" },
};
export function actorIcon(origin: HookOrigin): { url: string; label: string } | null {
  const username = origin.author?.trim();
  if (!username) return null;
  const key = username.toLowerCase().replace(/\[bot\]$/, "");
  const known = Object.hasOwn(ACTOR_ICONS, key) ? ACTOR_ICONS[key] : undefined;
  const login =
    known?.githubLogin ??
    (origin.provider === "github" && /^[\w-]+(?:\[bot\])?$/.test(username) ? username : null);
  return login
    ? {
        url: `https://github.com/${encodeURIComponent(login)}.png?size=48`,
        label: known?.label ?? username,
      }
    : null;
}
