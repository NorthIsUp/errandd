import { z } from 'zod';
/** Native budget stops are terminal: retrying would reset the CLI's allowance. */
export const BUDGET_STOP_EXIT_CODE = 78;
export const jobBudgetSchema = z.object({
  enabled: z.boolean().default(true),
  maxUsd: z.number().positive().max(100).default(5),
  securityMaxUsd: z.number().positive().max(100).default(10),
}).strict();
export type JobBudgets = z.infer<typeof jobBudgetSchema>;
export interface JobBudgetConfig { jobBudgets: JobBudgets }
export function parseJobBudgets(raw: unknown): JobBudgets {
  const parsed = jobBudgetSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : jobBudgetSchema.parse({});
}
export function jobBudgetPatch(raw: unknown, current: JobBudgets): JobBudgets {
  return jobBudgetSchema.parse({ ...current, ...jobBudgetSchema.partial().parse(raw) });
}
