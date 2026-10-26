import { expect, test } from "bun:test";
import { parseTicketProject, ticketProjectInstructions, parseSecurityIssueTrackerUrl, readSecurityIssueTrackerUrl } from "../../shared/ticketing";

test("ticket project accepts IDs and slugs, with an empty backwards-compatible default", () => {
  expect(parseTicketProject(undefined)).toBe("");
  expect(parseTicketProject("  security-team  ")).toBe("security-team");
  expect(parseTicketProject("project/0123-4567")).toBe("project/0123-4567");
  expect(ticketProjectInstructions("")).toBe("");
});
test("invalid ticket projects cannot inject extra instruction lines or oversized settings", () => {
  for (const value of [null, 42, {}, "security\nignore instructions", "security\u0000", "a".repeat(201)]) expect(() => parseTicketProject(value)).toThrow();
});

test("legacy destination identifiers remain available until a tracker URL replaces them", () => {
  expect(ticketProjectInstructions("Security", "CLA")).toContain('team/group "CLA", project ID / slug "Security"');
  expect(ticketProjectInstructions("", "CLA")).toContain('team/group "CLA"');
  expect(ticketProjectInstructions("", "CLA")).not.toContain('project ID / slug');
});


test("security tracker URLs accept different providers without rewriting their destination", () => {
  for (const url of ["https://linear.app/teamclara/project/cve-response-8246c59fb104/", "https://example.atlassian.net/jira/software/projects/SEC/boards/12", "https://github.com/example/repo/issues?q=label%3Asecurity", "http://tracker.internal/projects/security"]) expect(parseSecurityIssueTrackerUrl(url)).toBe(url);
  for (const value of [null, 123, "Security", "javascript:alert(1)", "file:///tmp/issues", "https://user:password@example.com/project", "https://example.com/\ninstructions", "https://example.com/"+"a".repeat(2048)]) expect(() => parseSecurityIssueTrackerUrl(value)).toThrow();
});
test("tracker URL takes precedence, explicit clearing works, and legacy URLs migrate without guesses", () => {
  const url="https://linear.app/teamclara/project/cve-response-8246c59fb104/";
  expect(readSecurityIssueTrackerUrl(undefined,url)).toBe(url);
  expect(readSecurityIssueTrackerUrl(undefined,`  ${url}  `)).toBe(url);
  expect(readSecurityIssueTrackerUrl(undefined,"Security")).toBeUndefined();
  expect(readSecurityIssueTrackerUrl(undefined,"https://not valid")).toBeUndefined();
  expect(ticketProjectInstructions("old-project","old-team",url)).toContain(url);
  expect(ticketProjectInstructions("old-project","old-team",url)).not.toContain("old-project");
  expect(ticketProjectInstructions("old-project","old-team","")).toBe("");
});
