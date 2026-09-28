import { z } from "zod";

/** Chrome window focus or active-tab change, as seen by the extension. */
export const FocusObservationSchema = z.object({
  kind: z.literal("focus"),
  seq: z.int().nonnegative(),
  at: z.number(),
  browserFocused: z.boolean(),
  windowId: z.int(),
  tabId: z.int().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  incognito: z.boolean().optional(),
  documentId: z.string().optional(),
});

/** Text read from a supported page (Phase 1: a GitHub issue). */
export const PageTextObservationSchema = z.object({
  kind: z.literal("page_text"),
  seq: z.int().nonnegative(),
  at: z.number(),
  tabId: z.int(),
  documentId: z.string(),
  url: z.string(),
  source: z.literal("github_issue"),
  title: z.string().max(300),
  text: z.string(),
  truncated: z.boolean(),
});

/** Host permissions currently granted to the extension. */
export const PermissionsObservationSchema = z.object({
  kind: z.literal("permissions"),
  granted: z.array(z.string()),
});

/** Extension -> core (via the native host). */
export const BrowserObservationSchema = z.discriminatedUnion("kind", [
  FocusObservationSchema,
  PageTextObservationSchema,
  PermissionsObservationSchema,
]);

export type FocusObservation = z.infer<typeof FocusObservationSchema>;
export type PageTextObservation = z.infer<typeof PageTextObservationSchema>;
export type PermissionsObservation = z.infer<typeof PermissionsObservationSchema>;
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;
