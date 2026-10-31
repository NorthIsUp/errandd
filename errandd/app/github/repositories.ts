import { z } from "zod";
import { getReadCache, type ReadCache } from "../readCache";

export const githubRepositoryName = z.string().regex(/^[a-z0-9][a-z0-9-]*\/(?!\.{1,2}$)[a-z0-9_.-]+$/i, "Invalid GitHub repository");
const event = z.object({
  repository: z.object({ full_name: githubRepositoryName }),
  label: z.object({ name: z.string() }).nullish(),
});
const NAMESPACE = "verified-github-repositories";

export class GithubRepositoryRegistry {
  constructor(private readonly cache: () => ReadCache = getReadCache) {}
  remember(payload: unknown): z.infer<typeof event> | undefined {
    const parsed = event.safeParse(payload);
    if (!parsed.success) return;
    const cache = this.cache();
    if (cache.get<boolean>(NAMESPACE, parsed.data.repository.full_name)?.value !== true) {
      cache.set(NAMESPACE, parsed.data.repository.full_name, true);
    }
    return parsed.data;
  }
  list(configured: string[]): string[] {
    const observed = this.cache().entries<boolean>(NAMESPACE).filter(([, saved]) => saved.value === true).map(([repo]) => repo);
    return [...new Set([...observed, ...configured].filter(repo => githubRepositoryName.safeParse(repo).success))];
  }
}
