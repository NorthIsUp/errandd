import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Job } from "./jobs";

export interface JobModel {
  runtime: string;
  model: string;
}

export function jobModelThreadId(threadId: string, choice?: JobModel): string {
  return choice ? `${threadId}:model:${encodeURIComponent(`${choice.runtime}/${choice.model}`)}` : threadId;
}

export function resolveJobModel(value: string, defaultRuntime: string, catalog?: string[]): JobModel {
  const [prefix, qualified] = value.split("/", 2);
  const model = qualified ?? prefix;
  const provider = qualified === undefined ? undefined : prefix.toLowerCase();
  const anthropic = /^(opus|sonnet|haiku|fable|claude-)/i.test(model);
  const openai = /^(sol|terra|astra|luna|gpt-|o[134](?:-|$))/i.test(model);
  const runtime = provider === "anthropic" ? "claude"
    : provider === "openai" ? "codex"
    : provider ?? (anthropic ? "claude" : openai ? "codex" : defaultRuntime);
  if (!model.trim()) throw new Error(`Missing model in ${value}`);
  if (runtime === "codex" && /^(sol|terra|astra|luna)$/i.test(model)) {
    const slug = (catalog ?? readCodexModels()).find((entry) => entry.endsWith(`-${model.toLowerCase()}`));
    if (!slug) throw new Error(`No Codex model found for ${model}; refresh the Codex model catalog or specify a full model ID`);
    return { runtime, model: slug };
  }
  return { runtime, model };
}

function readCodexModels(): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json"), "utf8")) as { models?: { slug?: unknown }[] };
    return (raw.models ?? []).flatMap((entry) => typeof entry.slug === "string" ? [entry.slug] : []);
  } catch {
    return [];
  }
}

/** Cursor survives routine reloads; restarting the daemon starts at the first choice. */
export class JobModelSelector {
  private readonly cursors = new Map<string, { signature: string; next: number }>();

  select(job: Pick<Job, "name" | "sourceDir" | "models" | "modelSelection">, random: () => number = Math.random): string | undefined {
    if (!job.models?.length) return undefined;
    if (job.modelSelection === "random") return job.models[Math.floor(random() * job.models.length)];
    const key = JSON.stringify([job.sourceDir, job.name]);
    const signature = JSON.stringify(job.models);
    const cursor = this.cursors.get(key);
    const index = cursor?.signature === signature ? cursor.next % job.models.length : 0;
    this.cursors.set(key, { signature, next: index + 1 });
    return job.models[index];
  }
}
