/** Retained for installations with older destination identifiers. */
export function parseTicketProject(value: unknown, label = "Ticket project"): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 200 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new Error(`${label} must be an ID or slug of at most 200 characters, on one line`);
  return value.trim();
}

export function parseSecurityIssueTrackerUrl(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 2048 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new Error("Enter a project tracker URL of at most 2048 characters, on one line");
  const text = value.trim();
  if (!text) return "";
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("Enter a valid HTTP or HTTPS project tracker URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP or HTTPS project tracker URL without embedded credentials");
  return text;
}

/** Only migrate a URL explicitly supplied earlier; never infer a workspace from IDs. */
export function readSecurityIssueTrackerUrl(value: unknown, legacyProject?: unknown): string | undefined {
  if (value !== undefined) return parseSecurityIssueTrackerUrl(value);
  if (typeof legacyProject === "string" && /^https?:\/\//i.test(legacyProject.trim())) {
    try { return parseSecurityIssueTrackerUrl(legacyProject); } catch { /* Preserve identifiers until a user supplies a valid URL. */ }
  }
  return undefined;
}

export function ticketProjectInstructions(project?: string, team?: string, trackerUrl?: string): string {
  const url = readSecurityIssueTrackerUrl(trackerUrl, project);
  if (url !== undefined) return url ? `## Tracking issue destination\n\nProject tracker URL for security issues: ${url}\n\nUse this URL to identify the tracker and the project, team or repository where security issues belong. Resolve that destination using the connected tracker tools. Search there for an existing issue using every CVE/GHSA alias and target repository before creating one. Keep it updated with findings, priority/urgency and fix PR links. If the destination is unavailable or ambiguous, report the blocker instead of choosing another destination.` : "";
  // Compatibility for user-saved identifiers until a replacement URL is configured.
  const value = parseTicketProject(project), group = parseTicketProject(team, "Tracker team/group");
  if (!value && !group) return "";
  const destination = [group ? `team/group ${JSON.stringify(group)}` : "", value ? `project ID / slug ${JSON.stringify(value)}` : ""].filter(Boolean).join(", ");
  return `## Tracking issue destination\n\nUse the previously configured ${destination} in the connected ticketing system for tracking issues. Resolve the configured destination before creating a ticket; do not substitute another destination if unavailable. Search for an existing issue there before creating one, and keep it updated with findings, priority/urgency and fix PR links.`;
}
