import { z } from "zod";

/** `context_status` output from the personal-context service; every rank response carries the same three fields. */
export const ContextStatusSchema = z.object({
  /** Random per personal-context service process start. */
  serviceInstanceId: z.string(),
  /** Bumps on each accepted activity observation or expiry. */
  activityRevision: z.int().nonnegative(),
  /** Hash of the enabled source config. */
  sourceGrantRevision: z.string(),
});

export type ContextStatus = z.infer<typeof ContextStatusSchema>;
