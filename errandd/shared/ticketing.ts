/** A destination in the already-configured ticketing system, not a credential. */
export function parseTicketProject(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 200 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new Error("Ticket project must be an ID or slug of at most 200 characters, on one line");
  return value.trim();
}

export function ticketProjectInstructions(project?: string): string {
  const value = parseTicketProject(project);
  return value ? `## Tracking issue destination\n\nUse project ID / slug ${JSON.stringify(value)} in the configured ticketing system for tracking issues. Search for an existing issue in this project before creating one, and keep it updated with findings, priority/urgency and fix PR links.` : "";
}
