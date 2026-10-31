import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSettings } from "../config";

const exec = promisify(execFile);
const YELLOW = "FBCA04";
type Github = (args: string[]) => Promise<string>;
interface Label { name: string; color: string; description?: string | null }
interface Issue { number: number; labels: (string | { name: string })[] }
const github: Github = async args => (await exec("gh", args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

export async function migrateLegacyLabels(repo: string, read: Github): Promise<{ renamed: number; assignments: number; recolored: number }> {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(repo)) throw new Error("Invalid GitHub repository");
  const base = `repos/${repo}`;
  const labels = (await read(["api", "--paginate", `${base}/labels?per_page=100`, "--jq", "map({name,color,description})|@json"]))
    .trim().split("\n").filter(Boolean).flatMap(page => JSON.parse(page) as Label[]);
  const byName = new Map(labels.map(label => [label.name.toLowerCase(), label]));
  const result = { renamed: 0, assignments: 0, recolored: 0 };
  const patch = (name: string, fields: string[]) => read(["api", "--method", "PATCH", `${base}/labels/${encodeURIComponent(name)}`, ...fields.flatMap(field => ["-f", field])]);
  for (const label of labels) {
    if (/^errandd:/i.test(label.name) && label.color.toUpperCase() !== YELLOW) {
      await patch(label.name, [`color=${YELLOW}`]);
      result.recolored++;
    }
    if (!/^claw:/i.test(label.name)) continue;
    const canonical = `errandd:${label.name.slice(5)}`;
    const existing = byName.get(canonical.toLowerCase());
    if (!existing) {
      await patch(label.name, [`new_name=${canonical}`, `color=${YELLOW}`]);
      byName.set(canonical.toLowerCase(), { name: canonical, color: YELLOW });
      result.renamed++;
      continue;
    }
    // Keep an empty alias definition: deleting it could remove a concurrent human hold.
    const description = `Legacy alias for ${canonical}; assignments are normalized automatically.`;
    if (label.color.toUpperCase() !== YELLOW || label.description !== description) {
      await patch(label.name, [`color=${YELLOW}`, `description=${description}`]);
    }
    const issues = (await read(["api", "--paginate", `${base}/issues?state=all&labels=${encodeURIComponent(label.name)}&per_page=100`, "--jq", 'map({number,labels:(.labels|map(if type == "string" then . else .name end))})|@json']))
      .trim().split("\n").filter(Boolean).flatMap(page => JSON.parse(page) as Issue[]);
    for (const issue of issues) {
      const names = issue.labels.map(value => typeof value === "string" ? value : value.name);
      if (!names.some(name => name.toLowerCase() === canonical.toLowerCase())) {
        await read(["api", "--method", "POST", `${base}/issues/${issue.number}/labels`, "-f", `labels[]=${existing.name}`]);
      }
      await read(["api", "--method", "DELETE", `${base}/issues/${issue.number}/labels/${encodeURIComponent(label.name)}`]);
      result.assignments++;
    }
  }
  return result;
}

export class LegacyLabelMigrator {
  private readonly pending = new Map<string, Promise<void>>();
  private tail = Promise.resolve();
  private sweepCursor = 0;
  constructor(private readonly enabled: () => boolean, private readonly read: Github = github,
    private readonly log: (message: string) => void = console.info) {}
  enqueue(repo: string): Promise<void> {
    if (!this.enabled() || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(repo)) return Promise.resolve();
    const pending = this.pending.get(repo);
    if (pending) return pending;
    if (this.pending.size >= 64) return Promise.resolve(); // The periodic sweep retries overflow.
    const run = this.tail.then(async () => {
      if (!this.enabled()) return;
      try {
        const result = await migrateLegacyLabels(repo, args => {
          if (!this.enabled()) throw new Error("Label migration disabled");
          return this.read(args);
        });
        if (Object.values(result).some(Boolean)) this.log(`Deterministic GitHub label migration for ${repo}: ${JSON.stringify(result)} (no LLM interaction)`);
      } catch (error) {
        if (this.enabled()) this.log(`Error: deterministic GitHub label migration for ${repo}: will retry on the next event or sweep: ${String(error)} (no LLM interaction)`);
      }
    }).finally(() => this.pending.delete(repo));
    this.pending.set(repo, run);
    this.tail = run;
    return run;
  }
  sweep(repos: string[]): void {
    if (!this.enabled() || !repos.length) return;
    const start = this.sweepCursor % repos.length;
    let visited = 0;
    while (visited < repos.length && this.pending.size < 64) {
      void this.enqueue(repos[(start + visited) % repos.length]);
      visited++;
    }
    this.sweepCursor = (start + visited) % repos.length;
  }
}
export const legacyLabelMigrator = new LegacyLabelMigrator(() => getSettings().migrateLegacyClawLabels);

export function observeLegacyLabel(payload: unknown): void {
  const data = payload as { repository?: { full_name?: unknown }; label?: { name?: unknown } } | null;
  if (typeof data?.repository?.full_name === "string" && typeof data?.label?.name === "string" && /^claw:/i.test(data.label.name)) {
    void legacyLabelMigrator.enqueue(data.repository.full_name);
  }
}
