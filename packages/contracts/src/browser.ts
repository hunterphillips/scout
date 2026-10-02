import { z } from "zod";
import { isHttpsOrigin } from "./capability.js";

/** Caps the content script enforces; re-checked here so a misbehaving extension is dropped, not trusted. */
export const PAGE_TEXT_TITLE_MAX_CHARS = 300;
export const PAGE_TEXT_BODY_MAX_BYTES = 8 * 1024;

// TextEncoder, not Buffer: this module is bundled into the Chrome extension.
const utf8Encoder = new TextEncoder();

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
  /** The permissions snapshot revision the extension had last sent when it sent this focus. */
  permissionsRevision: z.int().nonnegative().optional(),
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
  title: z.string().max(PAGE_TEXT_TITLE_MAX_CHARS),
  text: z.string().refine((t) => utf8Encoder.encode(t).byteLength <= PAGE_TEXT_BODY_MAX_BYTES, {
    message: `text exceeds ${PAGE_TEXT_BODY_MAX_BYTES} bytes`,
  }),
  truncated: z.boolean(),
  /**
   * The latest core `capture_policy` revision the extension had when it captured this text.
   * The core accepts text only under its current policy revision; missing means never.
   */
  policyRevision: z.int().nonnegative().optional(),
});

/**
 * True when `p` is an exact-host https permission pattern `https://<host>/*`: the host an
 * RFC 1123 hostname as isHttpsOrigin defines it, with no wildcard and no port.
 */
export function isExactOriginPattern(p: string): boolean {
  if (typeof p !== "string" || !p.endsWith("/*")) return false;
  const origin = p.slice(0, -2);
  return isHttpsOrigin(origin) && !/:\d+$/.test(origin);
}

/**
 * The extension's full permissions snapshot: every exact origin the user granted, and the
 * popup's GitHub-capture toggle. `revision` rises with every snapshot an extension worker
 * sends (seeded from the clock, so a worker restart never goes backwards). A new bridge
 * connection must send one before the core accepts focus or page text.
 */
export const PermissionsObservationSchema = z.object({
  kind: z.literal("permissions"),
  revision: z.int().nonnegative(),
  at: z.number(),
  granted: z.array(z.string().refine(isExactOriginPattern, { message: "not an exact https origin pattern" })),
  githubCapture: z.boolean(),
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
