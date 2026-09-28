export { CANDIDATE_DESCRIPTION_MAX, CANDIDATE_TITLE_MAX } from "@scout/contracts";

/**
 * How much raw input `sanitizeLabel` reads, as a multiple of `maxLength` (UTF-16 units).
 * Markup and invisible characters shrink the text, so the passes need some slack beyond
 * `maxLength`; bounding it keeps every pass linear in `maxLength`, not in the input.
 */
export const SANITIZE_INPUT_FACTOR = 8;

// Control characters (C0 and C1, including tab and newlines) become spaces.
const CONTROL = /\p{Cc}/gu;
// Invisible format characters are removed: zero-width, bidi marks/embeddings/overrides/
// isolates, BOM, soft hyphen, word joiners, Mongolian vowel separator, Unicode tag characters.
const FORMAT = /\p{Cf}/gu;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
// The `](target)` half of a Markdown link; the label half is kept.
const MARKDOWN_LINK_TARGET = /\]\([^)]*\)/g;
const TAG = /<[^>]*>/g;

/** Cut `text` to `limit` UTF-16 units, dropping a split surrogate and any trailing unterminated markup. */
function preCut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let out = text.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  // The cut may leave `<...`, `](...` or `![...` open; its tail is markup, not label text.
  // Cut at the first opener with no closer after it, so every opener kept is terminated.
  const cutAtUnclosed = (opener: string, closer: string): void => {
    const open = out.indexOf(opener, out.lastIndexOf(closer) + 1);
    if (open >= 0) out = out.slice(0, open);
  };
  cutAtUnclosed("<", ">");
  cutAtUnclosed("](", ")");
  cutAtUnclosed("![", ")");
  return out;
}

/**
 * Turn site-published text into a plain display label.
 *
 * Policy: site text is data only. Only the first `maxLength * SANITIZE_INPUT_FACTOR` UTF-16
 * units are read. Control and invisible formatting characters are removed, Markdown images
 * are dropped, Markdown links keep only their label (brackets are removed), HTML-like tags
 * and backticks are removed, whitespace collapses to single spaces, and the result is cut
 * to at most `maxLength` code points (never splitting a surrogate pair). The output carries
 * no link syntax, so a label cannot smuggle in a destination.
 */
export function sanitizeLabel(text: string, maxLength: number): string {
  let out = preCut(text, Math.max(0, maxLength) * SANITIZE_INPUT_FACTOR);
  out = out.replace(CONTROL, " ").replace(FORMAT, "").replace(MARKDOWN_IMAGE, " ");
  // Dropping every link target and then every bracket also covers labels that contain
  // brackets of their own, which a single `[label](url)` pattern would miss.
  out = out.replace(MARKDOWN_LINK_TARGET, "").replace(/[[\]]/g, "");
  out = out.replace(TAG, " ").replace(/`/g, "").replace(/\s+/g, " ").trim();
  const codePoints = Array.from(out);
  return codePoints.length <= maxLength ? out : codePoints.slice(0, maxLength).join("").trimEnd();
}
