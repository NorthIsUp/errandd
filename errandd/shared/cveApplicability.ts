import { z } from "zod";

export const applicabilityCoverageSchema = z.object({
  dependencies: z.string().trim().min(20).max(2000),
  sourceAndConfiguration: z.string().trim().min(20).max(2000),
  vendoredAndGenerated: z.string().trim().min(20).max(2000),
  imagesAndArtifacts: z.string().trim().min(20).max(2000),
  deploymentAndRuntime: z.string().trim().min(20).max(2000),
});
export const cveApplicabilitySchema = z.object({
  verdict: z.literal("not_affected"),
  context: z.string().regex(/^[a-f0-9]{32}$/),
  reason: z.string().trim().min(40).max(8000),
  evidence: z.array(z.url().refine(url => /^https?:\/\//.test(url))).min(1).max(30),
  coverage: applicabilityCoverageSchema,
  unscannedPathEvidence: z.record(z.string(), z.string().trim().min(20).max(2000)).default({}),
});
export type CveApplicability = z.infer<typeof cveApplicabilitySchema> & { assessedAt: number; repositoryRevision: string };
