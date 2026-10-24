import { z } from "zod";

export const JOB_ACTIVITY = "errandd.job.v1";
export const jobActivitySchema = z.object({
  jobId: z.string(),
  title: z.string(),
  provider: z.string(),
  action: z.string(),
  author: z.string(),
  status: z.enum(["received", "queued", "running", "waiting", "completed", "declined"]),
  stage: z.string(),
  completed: z.number().int().min(0).max(4),
});
export const workflowStateSchema = z.object({
  erranddDemo: jobActivitySchema.extend({
    detail: z.enum(["summary", "full"]),
    activityId: z.string(),
    decisionToolId: z.string().optional(),
    interruptId: z.string().optional(),
  }),
});
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export const reviewReportSchema = z.object({
  title: z.string(),
  checks: z.array(z.object({ name: z.string(), result: z.string() })),
  files: z.array(z.string()),
  diff: z.string(),
  artifact: z.object({ name: z.string(), text: z.string() }),
});
