import { z } from "zod";

/** The page the user is on right now. Owned by the core. */
export const ActiveVisitSchema = z.object({
  epoch: z.int().nonnegative(),
  tabId: z.int(),
  documentId: z.string().optional(),
  origin: z.string(),
  url: z.string(),
  startedAt: z.number(),
  contextRevision: z.int().nonnegative(),
});

export type ActiveVisit = z.infer<typeof ActiveVisitSchema>;
