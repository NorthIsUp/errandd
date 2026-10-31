import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSettings } from "../config";
import { z } from "zod";
import { githubRepositoryName, GithubRepositoryRegistry } from "./repositories";

const exec = promisify(execFile);
const YELLOW = "FBCA04";
type Github = (args: string[]) => Promise<string>;
const labelPage = z.array(z.object({ name: z.string().min(1), color: z.string().regex(/^[a-f0-9]{6}$/i), description: z.string().nullish() }));
const issuePage = z.array(z.object({ number: z.number().int().positive(), labels: z.array(z.string()) }));
function pages<T>(output: string, schema: z.ZodType<T[]>): T[] {
  return output.trim().split("\n").filter(Boolean).flatMap(page => schema.parse(JSON.parse(page)));
}
const github: Github = async args => (await exec("gh", args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

export async function migrateLegacyLabels(repo: string, read: Github): Promise<{ renamed: number; assignments: number; recolored: number }> {
  githubRepositoryName.parse(repo);
  const base = `repos/${repo}`;
  const labels = pages(await read(["api", "--paginate", `${base}/labels?per_page=100`, "--jq", "map({name,color,description})|@json"]), labelPage);
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
    const issues = pages(await read(["api", "--paginate", `${base}/issues?state=all&labels=${encodeURIComponent(label.name)}&per_page=100`, "--jq", 'map({number,labels:(.labels|map(if type == "string" then . else .name end))})|@json']), issuePage);
    for (const issue of issues) {
      if (!issue.labels.some(name => name.toLowerCase() === canonical.toLowerCase())) {
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
    private readonly log: (message: string) => void = console.info,
    private readonly repositories = new GithubRepositoryRegistry()) {}
  enqueue(repo: string): Promise<void> {
    if (!this.enabled() || !githubRepositoryName.safeParse(repo).success) return Promise.resolve();
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
        this.failed(repo, error);
      }
    }).finally(() => this.pending.delete(repo));
    this.pending.set(repo, run);
    this.tail = run;
    return run;
  }
  private failed(scope: string, error: unknown): void {
    if (this.enabled()) this.log(`Error: deterministic GitHub label migration for ${scope}: will retry on the next event or sweep: ${String(error)} (no LLM interaction)`);
  }
  observe(payload: unknown, verified: boolean): void {
    if (!verified) return;
    try {
      const event = this.repositories.remember(payload);
      if (event?.label && /^claw:/i.test(event.label.name)) void this.enqueue(event.repository.full_name);
    } catch (error) { this.failed("repository discovery", error); }
  }
  sweep(repos?: string[]): void {
    if (!this.enabled()) return;
    let targets: string[];
    try { targets = repos ?? this.repositories.list(getSettings().hooks.defaultPrRepo); }
    catch (error) { this.failed("repository discovery", error); return; }
    if (!targets.length) return;
    const start = this.sweepCursor % targets.length;
    let visited = 0;
    while (visited < targets.length && this.pending.size < 64) {
      void this.enqueue(targets[(start + visited) % targets.length]);
      visited++;
    }
    this.sweepCursor = (start + visited) % targets.length;
  }
}
export const legacyLabelMigrator = new LegacyLabelMigrator(() => getSettings().migrateLegacyClawLabels);
