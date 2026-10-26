/** A destination in the already-configured ticketing system, not a credential. */
export function parseTicketProject(value: unknown, label = "Ticket project"): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 200 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new Error(`${label} must be an ID or slug of at most 200 characters, on one line`);
  return value.trim();
}

export function ticketProjectInstructions(project?: string, team?: string): string {
  const value = parseTicketProject(project), group = parseTicketProject(team, "Linear team/group");
  if (!value && !group) return "";
  const destination = [group ? `Linear team/group ${JSON.stringify(group)}` : "", value ? `project ID / slug ${JSON.stringify(value)}` : ""].filter(Boolean).join(", ");
  return `## Tracking issue destination\n\nUse ${destination} in the configured ticketing system for tracking issues. Resolve the configured team and project before creating a ticket; do not substitute another destination if unavailable. Search for an existing issue in this destination before creating one, and keep it updated with findings, priority/urgency and fix PR links.`;
}
