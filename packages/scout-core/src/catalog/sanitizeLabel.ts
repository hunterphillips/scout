export { CANDIDATE_DESCRIPTION_MAX, CANDIDATE_TITLE_MAX } from "@scout/contracts";

// C0 and C1 control characters, including tab and newlines (they become spaces).
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
// Zero-width, directional mark, bidi embedding/override/isolate, and BOM characters.
const FORMAT = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
// The `](target)` half of a Markdown link; the label half is kept.
const MARKDOWN_LINK_TARGET = /\]\([^)]*\)/g;
const TAG = /<[^>]*>/g;

/**
 * Turn site-published text into a plain display label.
 *
 * Policy: site text is data only. Control and invisible formatting characters are removed,
 * Markdown images are dropped, Markdown links keep only their label (brackets are removed), HTML-like
 * tags and backticks are removed, whitespace collapses to single spaces, and the result is cut to
 * at most `maxLength` code points (never splitting a surrogate pair). The output carries
 * no link syntax, so a label cannot smuggle in a destination.
 */
export function sanitizeLabel(text: string, maxLength: number): string {
  let out = text.replace(CONTROL, " ").replace(FORMAT, "").replace(MARKDOWN_IMAGE, " ");
  // Dropping every link target and then every bracket also covers labels that contain
  // brackets of their own, which a single `[label](url)` pattern would miss.
  out = out.replace(MARKDOWN_LINK_TARGET, "").replace(/[[\]]/g, "");
  out = out.replace(TAG, " ").replace(/`/g, "").replace(/\s+/g, " ").trim();
  const codePoints = Array.from(out);
  return codePoints.length <= maxLength ? out : codePoints.slice(0, maxLength).join("").trimEnd();
}
