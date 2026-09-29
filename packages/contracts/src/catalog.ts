import { z } from "zod";

export const CANDIDATE_TITLE_MAX = 160;
export const CANDIDATE_DESCRIPTION_MAX = 400;

/** One link a site publishes about itself. */
export const CandidateSchema = z.object({
  /** "c" + base36 index, stable per catalog version. */
  id: z.string().regex(/^c[0-9a-z]+$/),
  /**
   * As published, after WHATWG URL normalization (resolved, dot segments removed, host
   * lowercased). Any fragment and tracking parameters are kept; only the dedupe key drops them.
   */
  sourceUrl: z.string(),
  /** Set only after verification. */
  humanHref: z.string().optional(),
  title: z.string().max(CANDIDATE_TITLE_MAX),
  description: z.string().max(CANDIDATE_DESCRIPTION_MAX).optional(),
  labelQuality: z.enum(["published", "image_title", "slug"]),
  provenance: z.enum(["llms.txt", "sitemap", "sitemap-image"]),
});

export const SiteCatalogSchema = z.object({
  origin: z.string(),
  version: z.string(),
  fetchedAt: z.number(),
  candidates: z.array(CandidateSchema),
  truncated: z.boolean(),
  errors: z.array(z.string()),
});

export type Candidate = z.infer<typeof CandidateSchema>;
export type SiteCatalog = z.infer<typeof SiteCatalogSchema>;
